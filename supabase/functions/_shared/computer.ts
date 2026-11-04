// Answers Gemini-shaped requests with the owner's AI on their Computer, when Huddle runs on one, so
// callers don't change. Computer's MCP for apps (ask_ai, transcribe) is reached through its app door
// with Huddle's own app key; Computer never gives that AI tools, files or keys.
//   COMPUTER_URL           the app door, e.g. http://host.docker.internal:3090
//   COMPUTER_EVENTS_KEY    Huddle's key, from /data/secrets/apps/huddle/events.json on the Computer
//   COMPUTER_APP           the app's name on the Computer (default huddle)
//   responseSchema         → the schema is spelled out in the instructions and the JSON is checked
//   images                 → sent along (ask_ai refuses them plainly when the owner's model can't see)
//   audio                  → turned into words by the Computer's own speech service first
//   video / PDFs           → not sent here (util.ts uses Gemini for them when GEMINI_API_KEY is set)
//   tools: google_search   → no live search here: answered from what the model knows, and unsourced
import type { GeminiResult } from "./util.ts";
import { clip, span } from "./trace.ts";
import { jsonOnly, schema } from "./openai.ts";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const BASE = env("COMPUTER_URL", "http://host.docker.internal:3090").replace(/\/$/, "");
const KEY = env("COMPUTER_EVENTS_KEY");
const APP = env("COMPUTER_APP", "huddle");
const TIMEOUT_MS = Number(env("COMPUTER_TIMEOUT_MS", "300000"));

// deno-lint-ignore no-explicit-any
type Any = any;

/** Computer said no in words (allowance used up, can't see, busy): a sentence, never a crash. */
export class ComputerSaid extends Error {
  constructor(message: string, readonly lasting: boolean) {
    super(message);
  }
}

export const computerConfigured = () => !!KEY;

// After "used today's allowance" or "not on this setup", don't ask again for a while: every request
// would wait for the same no before falling back.
let restUntil = 0;
export const computerResting = () => Date.now() < restUntil;

let nextId = 1;
async function tool(name: string, args: Record<string, unknown>): Promise<string> {
  const r = await fetch(`${BASE}/api/app-mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${KEY}`,
      "x-computer-app": APP,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.error) throw new Error(`Computer ${r.status}: ${body.error?.message ?? "no answer"}`);
  const text = String(body.result?.content?.[0]?.text ?? "");
  if (body.result?.isError) {
    const lasting = /allowance|on this setup|look at pictures/i.test(text);
    if (lasting) restUntil = Date.now() + 15 * 60_000;
    throw new ComputerSaid(text, lasting);
  }
  return text;
}

const data = (p: Any) => p.inline_data ?? p.inlineData;
const mimeOf = (p: Any) => String(data(p)?.mime_type ?? data(p)?.mimeType ?? "").split(";")[0];
const fromB64 = (b64: string) => new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));

/** Words from a recording, by the Computer's speech service. "" when no one spoke. */
export async function computerTranscribe(audio: string, mime = "audio/wav"): Promise<string> {
  return await span("computer.transcribe", "LLM", { "llm.provider": "computer", "input.mime_type": mime }, async (s) => {
    const out = JSON.parse(await tool("transcribe", { audio, mime })) as { text?: string };
    const text = String(out.text ?? "").trim();
    s.set({ "output.value": clip(text), "output.mime_type": "text/plain" });
    return text;
  });
}

export async function computer(body: Any): Promise<GeminiResult> {
  if (!computerConfigured()) throw new Error("Set COMPUTER_EVENTS_KEY to use the Computer's AI");
  const parts: Any[] = (body.contents ?? []).flatMap((c: Any) => c.parts ?? []);
  const texts: string[] = [];
  const images: { mime: string; data: string }[] = [];
  let heard = false;
  for (const p of parts) {
    if (p.text != null) { texts.push(String(p.text)); continue; }
    if (!data(p)) continue;
    const mime = mimeOf(p);
    if (mime.startsWith("image/")) images.push({ mime, data: data(p).data });
    else if (mime.startsWith("text/") || mime === "application/json") texts.push(`Attached file (${mime}):\n${fromB64(data(p).data)}`);
    else if (mime.startsWith("audio/")) {
      heard = true;
      const words = await computerTranscribe(data(p).data, mime);
      texts.push(words
        ? `The recording, already turned into words by a speech service (use these words exactly as the transcript):\n"""\n${words}\n"""`
        : "The recording had no clear speech in it.");
    } else throw new Error(`the Computer's AI can't read ${mime || "that file"}`);
  }
  const gc = body.generationConfig ?? {};
  const wantJson = !!gc.responseSchema || gc.responseMimeType === "application/json";
  const search = (body.tools ?? []).some((t: Any) => t.google_search || t.googleSearch);

  // Only a recording (transcribe/index.ts asks the speech model directly): its words are the answer.
  if (heard && !images.length && texts.every((t) => t.startsWith("The recording")) && !wantJson) {
    const text = texts.map((t) => t.match(/"""\n([\s\S]*)\n"""/)?.[1] ?? "").join(" ").trim();
    return { text, raw: { candidates: [{ content: { parts: [{ text }] } }] } };
  }

  const system = (body.systemInstruction?.parts ?? []).map((p: Any) => p.text).filter(Boolean).join("\n\n");
  const notes: string[] = [];
  if (gc.responseSchema) {
    notes.push(`Reply with one JSON object only (no markdown, no prose around it), matching this JSON Schema:\n${JSON.stringify(schema(gc.responseSchema))}`);
  } else if (wantJson) notes.push("Reply with JSON only, no markdown or prose around it.");
  if (search) {
    notes.push("You can't search the web here. Answer from what you know, say plainly that facts and prices weren't " +
      "checked online, and don't invent links or sources.");
  }
  // Free text can be a whole web page; structured answers are short.
  const maxWords = gc.maxOutputTokens ? Math.round(Number(gc.maxOutputTokens) * 0.75) : wantJson ? 3000 : 10000;
  const prompt = texts.join("\n\n");
  const instructions = [system, ...notes].filter(Boolean).join("\n\n");

  return await span("computer.ask_ai", "LLM", {
    "llm.provider": "computer", "llm.model_name": "owner's AI",
    "input.value": clip(prompt), "input.mime_type": "text/plain",
    ...(system ? { "llm.input_messages.0.message.role": "system", "llm.input_messages.0.message.content": clip(system, 4000) } : {}),
  }, async (s) => {
    const ask = (extra = "") => tool("ask_ai", {
      prompt: extra ? `${prompt}\n\n${extra}` : prompt,
      ...(instructions ? { instructions } : {}),
      max_words: Math.min(Math.max(maxWords, 20), 12000),
      ...(images.length ? { images } : {}),
    });
    const reply = await ask();
    let text = wantJson ? jsonOnly(reply) : reply.trim();
    // Callers parse structured answers as JSON: if this one isn't, ask once more, showing what came back.
    if (wantJson && !parses(text)) {
      text = jsonOnly(await ask(`Your last reply wasn't valid JSON:\n${reply.slice(0, 4000)}\n\nReply again with only the JSON object, nothing else.`));
    }
    s.set({ "output.value": clip(text), "output.mime_type": wantJson ? "application/json" : "text/plain" });
    // No grounding: research made here is reported unsourced, which the pipeline already flags.
    return { text, raw: { computer: true, candidates: [{ content: { parts: [{ text }] }, groundingMetadata: { groundingChunks: [] } }] } };
  });
}

const parses = (t: string) => { try { JSON.parse(t); return true; } catch { return false; } };
