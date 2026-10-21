// Answers Gemini-shaped requests with any OpenAI-compatible chat API, so callers don't change:
// Ollama (local or its cloud models), OpenRouter, vLLM, LM Studio, OpenAI, Together, Groq and the like.
//   OPENAI_BASE_URL        e.g. http://host.docker.internal:11434/v1 (Ollama), https://openrouter.ai/api/v1
//   OPENAI_API_KEY         optional (Ollama needs none)
//   OPENAI_MODEL           the everyday model (brief, intake, reviews, plans)
//   OPENAI_SMART_MODEL     free-text work (prototypes, research write-ups); defaults to OPENAI_MODEL
//   OPENAI_VISION_MODEL    for photos, sketches and screenshots; defaults to OPENAI_MODEL
//   responseSchema         → response_format json_schema (falls back to json_object + the schema in the prompt)
//   tools: google_search   → no live search here: the model answers from what it knows and the job is marked
//                            unsourced. (util.ts sends search to Gemini instead when SEARCH_PROVIDER=gemini.)
//   audio / video          → not sent here (util.ts uses Gemini for them when GEMINI_API_KEY is set)
import type { GeminiResult } from "./util.ts";
import { clip, span } from "./trace.ts";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const BASE = env("OPENAI_BASE_URL").replace(/\/$/, "");
const KEY = env("OPENAI_API_KEY");
const FAST = env("OPENAI_MODEL");
const SMART = env("OPENAI_SMART_MODEL", FAST);
const VISION = env("OPENAI_VISION_MODEL", FAST);
const TIMEOUT_MS = Number(env("OPENAI_TIMEOUT_MS", "240000"));

// deno-lint-ignore no-explicit-any
type Any = any;

// Gemini's OpenAPI subset (type: "OBJECT") → JSON Schema (type: "object").
function schema(s: Any): Any {
  if (Array.isArray(s)) return s.map(schema);
  if (!s || typeof s !== "object") return s;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === "nullable" || k === "propertyOrdering") continue;
    if (k === "type") out.type = String(v).toLowerCase();
    else if (k === "properties") out.properties = Object.fromEntries(Object.entries(v as object).map(([pk, pv]) => [pk, schema(pv)]));
    else out[k] = schema(v);
  }
  return out;
}

const fromB64 = (b64: string) => new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));

function part(p: Any) {
  if (p.text != null) return { type: "text", text: String(p.text) };
  const d = p.inline_data ?? p.inlineData;
  if (!d) return null;
  const mime = String(d.mime_type ?? d.mimeType ?? "").split(";")[0];
  if (mime.startsWith("image/")) return { type: "image_url", image_url: { url: `data:${mime};base64,${d.data}` } };
  if (mime.startsWith("text/") || mime === "application/json") return { type: "text", text: `Attached file (${mime}):\n${fromB64(d.data)}` };
  throw new Error(`this model can't read ${mime || "that file"}`);
}

/** Pull the JSON out of a reply that may carry thinking, a code fence or a sentence around it. */
function jsonOnly(text: string) {
  const t = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const s = (fenced ? fenced[1] : t).trim();
  if (/^[\[{]/.test(s)) return s;
  const start = s.search(/[\[{]/);
  const end = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
  return start >= 0 && end > start ? s.slice(start, end + 1) : s;
}

const parses = (t: string) => { try { JSON.parse(t); return true; } catch { return false; } };

async function chat(payload: Any) {
  const r = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(KEY ? { authorization: `Bearer ${KEY}` } : {}) },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await r.text();
  if (!r.ok) throw Object.assign(new Error(`Model ${payload.model} ${r.status}: ${text.slice(0, 500)}`), { status: r.status });
  return JSON.parse(text);
}

export const openaiConfigured = () => !!(BASE && FAST);

/** Which model this request would use: the vision model for images, the smart one when asked for it. */
export function openaiModelFor(body: Any, wantSmart: boolean) {
  const hasImage = (body.contents ?? []).some((c: Any) => (c.parts ?? []).some((p: Any) =>
    String((p.inline_data ?? p.inlineData)?.mime_type ?? (p.inline_data ?? p.inlineData)?.mimeType ?? "").startsWith("image/")));
  return hasImage ? VISION : wantSmart ? SMART : FAST;
}

export async function openai(body: Any): Promise<GeminiResult> {
  if (!openaiConfigured()) throw new Error("Set OPENAI_BASE_URL and OPENAI_MODEL to use an OpenAI-compatible model");
  const content = (body.contents ?? []).flatMap((c: Any) => (c.parts ?? []).map(part).filter(Boolean));
  const gc = body.generationConfig ?? {};
  const search = (body.tools ?? []).some((t: Any) => t.google_search || t.googleSearch);
  const system = (body.systemInstruction?.parts ?? []).map((p: Any) => p.text).filter(Boolean).join("\n\n");
  const notes: string[] = [];
  const wantJson = !!gc.responseSchema || gc.responseMimeType === "application/json";
  // Not every server enforces response_format, so the shape is also spelled out in the instructions.
  if (gc.responseSchema) {
    notes.push(`Reply with one JSON object only (no markdown, no prose around it), matching this JSON Schema:\n${JSON.stringify(schema(gc.responseSchema))}`);
  } else if (wantJson) notes.push("Reply with JSON only, no markdown or prose around it.");
  if (search) {
    notes.push("You can't search the web here. Answer from what you know, say plainly that facts and prices weren't " +
      "checked online, and don't invent links or sources.");
  }
  // Free text (pages, write-ups, research) gets the smart model; short structured answers the everyday one.
  const model = openaiModelFor(body, !gc.responseSchema || !!search);
  // A single text part reads better as a plain string for models that don't take content arrays.
  const userContent = content.length === 1 && content[0].type === "text" ? content[0].text : content;
  const messages: Any[] = [];
  if (system || notes.length) messages.push({ role: "system", content: [system, ...notes].filter(Boolean).join("\n\n") });
  messages.push({ role: "user", content: userContent });
  const payload: Any = { model, messages };
  if (gc.temperature != null) payload.temperature = gc.temperature;
  if (gc.maxOutputTokens) payload.max_tokens = Number(gc.maxOutputTokens);
  if (gc.responseSchema) payload.response_format = { type: "json_schema", json_schema: { name: "respond", schema: schema(gc.responseSchema) } };
  else if (wantJson) payload.response_format = { type: "json_object" };

  const promptText = content.map((c: Any) => c.text ?? `[${c.type}]`).join("\n");
  return await span(`openai.chat ${model}`, "LLM", {
    "llm.provider": "openai-compatible", "llm.model_name": model,
    "llm.invocation_parameters": JSON.stringify({ response_format: payload.response_format?.type ?? null, max_tokens: payload.max_tokens ?? null }),
    "input.value": clip(promptText), "input.mime_type": "text/plain",
    ...(system ? { "llm.input_messages.0.message.role": "system", "llm.input_messages.0.message.content": clip(system, 4000) } : {}),
  }, async (s) => {
    let res: Any;
    try {
      res = await chat(payload);
    } catch (e) {
      // Not every server takes json_schema: plain JSON mode (the shape is already in the instructions).
      if (!gc.responseSchema || (e as Any).status !== 400 && (e as Any).status !== 422) throw e;
      res = await chat({ ...payload, response_format: { type: "json_object" } });
    }
    const reply = String(res.choices?.[0]?.message?.content ?? "");
    let text = wantJson ? jsonOnly(reply) : reply.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
    // Callers parse structured answers as JSON: if this one isn't, ask once more, showing what came back.
    if (wantJson && !parses(text)) {
      res = await chat({
        ...payload, response_format: { type: "json_object" },
        messages: [...payload.messages, { role: "assistant", content: reply.slice(0, 4000) },
          { role: "user", content: "That wasn't valid JSON. Reply again with only the JSON object, nothing else." }],
      });
      text = jsonOnly(String(res.choices?.[0]?.message?.content ?? ""));
    }
    // No grounding: research made here is reported unsourced, which the pipeline already flags.
    const raw = { openai: res, candidates: [{ content: { parts: [{ text }] }, groundingMetadata: { groundingChunks: [] } }] };
    s.set({
      "output.value": clip(text), "output.mime_type": wantJson ? "application/json" : "text/plain",
      "llm.token_count.prompt": res.usage?.prompt_tokens, "llm.token_count.completion": res.usage?.completion_tokens,
      "llm.token_count.total": res.usage?.total_tokens,
    });
    return { text, raw };
  });
}
