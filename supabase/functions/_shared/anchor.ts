// Anchor Browser: a cloud browser for the agent. Used to read source pages during research and to
// smoke-test deployed prototypes (with a live view the room can watch). Needs ANCHOR_API_KEY.
import { clip, span } from "./trace.ts";

const BASE = "https://api.anchorbrowser.io";
const KEY = Deno.env.get("ANCHOR_API_KEY");
export const anchorOn = () => !!KEY;

async function call(path: string, init: RequestInit & { timeoutMs?: number } = {}) {
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "anchor-api-key": KEY!, "content-type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
  });
  if (!r.ok) throw new Error(`Anchor ${path} ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r;
}

/** Rough HTML → text, enough for a judge to check claims against the page. */
function htmlToText(html: string) {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|br|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

/** A page rendered in a real browser, as text. Web Unlocker is sessionless, so it never uses up browser slots. */
export function readPage(url: string): Promise<string> {
  return span("anchor.web_unlocker", "TOOL", { "tool.name": "anchor.fetch_webpage", "input.value": url }, async (s) => {
    const r = await call("/v1/tools/fetch/webpage", {
      method: "POST", body: JSON.stringify({ url, options: { return_partial_on_timeout: true } }), timeoutMs: 30_000,
    });
    const type = r.headers.get("content-type") ?? "";
    const raw = await r.text();
    const text = type.includes("html") ? htmlToText(raw) : raw;
    s.set({ "output.value": clip(text, 3000), metadata: { content_type: type, chars: text.length } });
    return text;
  });
}

export type Session = { id: string; liveViewUrl: string };

export async function openSession(url: string): Promise<Session> {
  const r = await call("/v1/sessions", {
    method: "POST",
    body: JSON.stringify({
      session: { initial_url: url, timeout: { max_duration: 8, idle_timeout: 3 }, live_view: { read_only: true } },
    }),
  });
  const j = await r.json();
  const d = j.data ?? j;
  return { id: d.id, liveViewUrl: d.live_view_url };
}

export async function closeSession(id: string) {
  await call(`/v1/sessions/${id}`, { method: "DELETE" }).catch((e) => console.warn(e));
}

export async function screenshot(id: string): Promise<Uint8Array> {
  const r = await call(`/v1/sessions/${id}/screenshot`, { timeoutMs: 20_000 });
  return new Uint8Array(await r.arrayBuffer());
}

export type SmokeResult = { works: boolean; tried: string; observed: string; problems: string[] };

/** Use the deployed app like a person would, inside a session whose live view the room can watch. */
export function smokeTest(sessionId: string, task: string): Promise<SmokeResult> {
  return span("anchor.perform_web_task (smoke test)", "TOOL", { "tool.name": "anchor.perform_web_task", "input.value": task }, async (s) => {
    const r = await call(`/v1/tools/perform-web-task?sessionId=${sessionId}`, {
      method: "POST",
      timeoutMs: 240_000,
      body: JSON.stringify({
        prompt: task,
        max_steps: 15,
        output_schema: {
          type: "object",
          properties: {
            works: { type: "boolean", description: "true if the core interaction did what it should" },
            tried: { type: "string", description: "what you did, step by step" },
            observed: { type: "string", description: "what the page showed in response" },
            problems: { type: "array", items: { type: "string" } },
          },
          required: ["works", "tried", "observed", "problems"],
        },
      }),
    });
    const j = await r.json();
    const d = j.data ?? j;
    let out = d.result ?? {};
    if (typeof out === "string") {
      try { out = JSON.parse(out); } catch { out = { works: false, tried: task, observed: out, problems: ["no structured result"] }; }
    }
    const res: SmokeResult = {
      works: !!out.works, tried: String(out.tried ?? ""), observed: String(out.observed ?? ""),
      problems: Array.isArray(out.problems) ? out.problems.map(String) : [],
    };
    s.set({ "output.value": JSON.stringify(res), metadata: { steps: d.steps?.length ?? d.steps, status: d.status } });
    return res;
  });
}
