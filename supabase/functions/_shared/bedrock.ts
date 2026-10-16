// Answers Gemini-shaped requests with Amazon Bedrock (Converse API), so callers don't change.
//   responseSchema       → forced tool call on BEDROCK_FAST_MODEL (Claude Haiku 4.5)
//   tools: google_search → BEDROCK_SEARCH_MODEL (Nova 2 Lite) with nova_grounding; citations → groundingChunks
//   video parts          → BEDROCK_MEDIA_MODEL (Nova 2 Lite; Claude can't read video)
//   free text (HTML)     → BEDROCK_SMART_MODEL (Claude Sonnet)
// Credentials: AWS_BEARER_TOKEN_BEDROCK, or the standard AWS_ACCESS_KEY_ID / SECRET / SESSION_TOKEN env vars
// (signed with SigV4 here, so no SDK). No Bedrock model accepts audio.
import type { GeminiResult } from "./util.ts";
import { clip, span } from "./trace.ts";

const env = (k: string, d: string) => Deno.env.get(k) ?? d;
const FAST = env("BEDROCK_FAST_MODEL", "us.anthropic.claude-haiku-4-5-20251001-v1:0");
const SMART = env("BEDROCK_SMART_MODEL", "us.anthropic.claude-sonnet-5-5");
const MEDIA = env("BEDROCK_MEDIA_MODEL", "us.amazon.nova-2-lite-v1:0");
const SEARCH = env("BEDROCK_SEARCH_MODEL", "us.amazon.nova-2-lite-v1:0");

const REGION = env("BEDROCK_REGION", env("AWS_REGION", "us-west-2"));

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
async function hmac(key: ArrayBuffer | Uint8Array, s: string) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return await crypto.subtle.sign("HMAC", k, enc.encode(s));
}

/** POST /model/{id}/converse, signed with SigV4 (or a Bedrock API key). */
// deno-lint-ignore no-explicit-any
async function converse(modelId: string, payload: unknown): Promise<any> {
  const host = `bedrock-runtime.${REGION}.amazonaws.com`;
  const path = `/model/${encodeURIComponent(modelId)}/converse`;
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const bearer = Deno.env.get("AWS_BEARER_TOKEN_BEDROCK");
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  else {
    const id = Deno.env.get("AWS_ACCESS_KEY_ID"), secret = Deno.env.get("AWS_SECRET_ACCESS_KEY");
    if (!id || !secret) throw new Error("Bedrock needs AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or AWS_BEARER_TOKEN_BEDROCK");
    const amzDate = new Date().toISOString().replace(/[-:]|\.\d{3}/g, "");
    const day = amzDate.slice(0, 8);
    headers.host = host;
    headers["x-amz-date"] = amzDate;
    const token = Deno.env.get("AWS_SESSION_TOKEN");
    if (token) headers["x-amz-security-token"] = token;
    const names = Object.keys(headers).sort();
    const canonical = [
      "POST", path.split("/").map(encodeURIComponent).join("/"), "",
      ...names.map((n) => `${n}:${headers[n]}`), "", names.join(";"), await sha256(body),
    ].join("\n");
    const scope = `${day}/${REGION}/bedrock/aws4_request`;
    const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256(canonical)].join("\n");
    let k = await hmac(enc.encode(`AWS4${secret}`), day);
    for (const s of [REGION, "bedrock", "aws4_request"]) k = await hmac(k, s);
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${id}/${scope}, SignedHeaders=${names.join(";")}, Signature=${hex(await hmac(k, toSign))}`;
    delete headers.host;
  }
  const r = await fetch(`https://${host}${path}`, { method: "POST", headers, body });
  if (!r.ok) throw new Error(`Bedrock ${modelId} ${r.status}: ${(await r.text()).slice(0, 500)}`);
  return await r.json();
}

// The REST API takes binary blocks as base64 strings, which is what Gemini parts already carry.
const bytes = (b64: string) => b64;
const DOCS: Record<string, string> = {
  "application/pdf": "pdf", "text/plain": "txt", "text/markdown": "md", "text/csv": "csv", "text/html": "html",
  "application/msword": "doc", "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};
const VIDEO: Record<string, string> = {
  "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm", "video/x-matroska": "mkv", "video/mpeg": "mpeg",
};

// deno-lint-ignore no-explicit-any
function part(p: any) {
  if (p.text != null) return { text: String(p.text) };
  const d = p.inline_data ?? p.inlineData;
  if (!d) return null;
  const mime = String(d.mime_type ?? d.mimeType ?? "").split(";")[0];
  if (mime.startsWith("image/")) return { image: { format: mime.slice(6).replace("jpg", "jpeg"), source: { bytes: bytes(d.data) } } };
  if (VIDEO[mime]) return { video: { format: VIDEO[mime], source: { bytes: bytes(d.data) } } };
  if (DOCS[mime] || mime.startsWith("text/")) return { document: { format: DOCS[mime] ?? "txt", name: "upload", source: { bytes: bytes(d.data) } } };
  if (mime.startsWith("audio/")) throw new Error("audio needs GEMINI_API_KEY (no Bedrock model reads audio)");
  throw new Error(`Bedrock can't read ${mime}`);
}

// Gemini's OpenAPI subset (type: "OBJECT") → JSON Schema (type: "object").
// deno-lint-ignore no-explicit-any
function schema(s: any): any {
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

// deno-lint-ignore no-explicit-any
function collectUrls(o: any, out: { uri: string; title?: string }[] = []) {
  if (!o || typeof o !== "object") return out;
  if (o.web?.url) out.push({ uri: o.web.url, title: o.web.title ?? o.web.domain });
  for (const v of Object.values(o)) collectUrls(v, out);
  return out;
}

// deno-lint-ignore no-explicit-any
export async function bedrock(body: any): Promise<GeminiResult> {
  const content = (body.contents ?? []).flatMap((c: any) => (c.parts ?? []).map(part).filter(Boolean));
  const system = (body.systemInstruction?.parts ?? []).map((p: any) => ({ text: p.text })).filter((p: any) => p.text);
  const gc = body.generationConfig ?? {};
  const search = (body.tools ?? []).some((t: any) => t.google_search || t.googleSearch);
  const video = content.some((c: any) => c.video);

  const input: any = { messages: [{ role: "user", content }], inferenceConfig: { maxTokens: 4096 } };
  if (system.length) input.system = system;
  if (gc.responseSchema) {
    input.modelId = video ? MEDIA : FAST;
    input.toolConfig = {
      tools: [{ toolSpec: { name: "respond", description: "Return the answer in this shape.", inputSchema: { json: schema(gc.responseSchema) } } }],
      toolChoice: { tool: { name: "respond" } },
    };
    input.inferenceConfig.maxTokens = 8192;
  } else if (search) {
    input.modelId = SEARCH;
    input.toolConfig = { tools: [{ systemTool: { name: "nova_grounding" } }] };
  } else {
    input.modelId = video ? MEDIA : SMART;
    input.inferenceConfig.maxTokens = 16000;
  }

  const { modelId, ...payload } = input;
  // One LLM span per model call (OpenInference attributes, so Arize shows prompt, output and tokens).
  const promptText = content.map((c: any) => c.text ?? `[${Object.keys(c)[0]}]`).join("\n");
  return await span(`bedrock.converse ${modelId}`, "LLM", {
    "llm.provider": "aws", "llm.system": modelId.includes("anthropic") ? "anthropic" : "amazon", "llm.model_name": modelId,
    "llm.invocation_parameters": JSON.stringify({ ...input.inferenceConfig, tool: input.toolConfig ? (gc.responseSchema ? "respond" : "nova_grounding") : null }),
    "input.value": clip(promptText), "input.mime_type": "text/plain",
    ...(system.length ? { "llm.input_messages.0.message.role": "system", "llm.input_messages.0.message.content": clip(system[0].text, 4000) } : {}),
    [`llm.input_messages.${system.length ? 1 : 0}.message.role`]: "user",
    [`llm.input_messages.${system.length ? 1 : 0}.message.content`]: clip(promptText),
  }, async (s) => {
    const res: any = await converse(modelId, payload);
    const blocks = res.output?.message?.content ?? [];
    const tool = blocks.find((b: any) => b.toolUse)?.toolUse;
    const text = tool ? JSON.stringify(tool.input) : blocks.map((b: any) => b.text ?? "").join("");
    const raw = {
      bedrock: res,
      candidates: [{ content: { parts: [{ text }] }, groundingMetadata: { groundingChunks: collectUrls(blocks).map((web) => ({ web })) } }],
    };
    s.set({
      "output.value": clip(text), "output.mime_type": tool ? "application/json" : "text/plain",
      "llm.output_messages.0.message.role": "assistant", "llm.output_messages.0.message.content": clip(text),
      "llm.token_count.prompt": res.usage?.inputTokens, "llm.token_count.completion": res.usage?.outputTokens,
      "llm.token_count.total": res.usage?.totalTokens,
    });
    return { text, raw };
  });
}
