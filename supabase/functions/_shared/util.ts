import { createClient } from "jsr:@supabase/supabase-js@2";

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });
}

export function db() {
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY")!;
  return createClient(url, key, { auth: { persistSession: false } });
}

const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY");
export const FAST_MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-3.8-flash";
export const SMART_MODEL = Deno.env.get("GEMINI_SMART_MODEL") ?? FAST_MODEL;

export type GeminiResult = { text: string; raw: any };

export async function gemini(body: Record<string, unknown>, model = FAST_MODEL): Promise<GeminiResult> {
  if (!GEMINI_KEY) throw new Error("GEMINI_API_KEY secret is not set");
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_KEY },
      body: JSON.stringify(body),
    },
  );
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 500)}`);
  const raw = await r.json();
  const parts = raw?.candidates?.[0]?.content?.parts ?? [];
  const text = parts.filter((p: any) => !p.thought).map((p: any) => p.text ?? "").join("");
  return { text, raw };
}

/** Ask for JSON matching a schema and parse it. */
export async function geminiJson<T>(
  parts: unknown[],
  schema: Record<string, unknown>,
  model = FAST_MODEL,
  system?: string,
  extraConfig: Record<string, unknown> = {},
): Promise<T> {
  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts }],
    generationConfig: { responseMimeType: "application/json", responseSchema: schema, ...extraConfig },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const { text } = await gemini(body, model);
  return JSON.parse(text) as T;
}

export function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/** Run work after responding (keeps the client snappy; status flows back over Realtime). */
export function background(p: Promise<unknown>) {
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(p);
  else p.catch(console.error);
}
