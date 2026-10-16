// Arize AX tracing without an SDK: OpenInference-shaped spans, exported as OTLP/HTTP JSON, plus
// span annotations (eval scores) through the Arize REST API. No-ops unless ARIZE_SPACE_ID and
// ARIZE_API_KEY are set.
//
// One pipeline = one trace: its trace id and root span id are derived from the pipeline id, so every
// stage, function call and model call across separate requests lands in the same trace.
import { AsyncLocalStorage } from "node:async_hooks";

export type Ctx = { traceId: string; spanId: string; session?: string; pipelineId?: number };
type Attrs = Record<string, unknown>;

// deno-lint-ignore no-explicit-any
const G = globalThis as any; // shared by the gateway and every function module
const als: AsyncLocalStorage<Ctx> = (G.__huddleAls ??= new AsyncLocalStorage<Ctx>());
const spans: unknown[] = (G.__huddleSpans ??= []);
const notes: { spanId: string; values: unknown[]; tries: number; due: number }[] = (G.__huddleNotes ??= []);

const SPACE = Deno.env.get("ARIZE_SPACE_ID");
const KEY = Deno.env.get("ARIZE_API_KEY");
const PROJECT = Deno.env.get("ARIZE_PROJECT") ?? "huddle";
const PROJECT_ID = Deno.env.get("ARIZE_PROJECT_ID");
export const tracing = !!(SPACE && KEY);

const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const randomId = (bytes: number) => hex(crypto.getRandomValues(new Uint8Array(bytes)));
async function derivedId(seed: string, bytes: number) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed))).slice(0, bytes * 2);
}

/** The trace every stage of a pipeline belongs to. */
export async function pipelineCtx(pipelineId: number, session?: string): Promise<Ctx> {
  return {
    traceId: await derivedId(`huddle-pipeline-${pipelineId}`, 16),
    spanId: await derivedId(`huddle-pipeline-root-${pipelineId}`, 8),
    session,
    pipelineId,
  };
}

export const current = () => als.getStore();

function otlpValue(v: unknown) {
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  return { stringValue: typeof v === "string" ? v : JSON.stringify(v) };
}
const otlpAttrs = (a: Attrs) =>
  Object.entries(a).filter(([, v]) => v != null && v !== "").map(([key, v]) => ({ key, value: otlpValue(v) }));

const b64 = (hexId: string) => btoa(String.fromCharCode(...hexId.match(/../g)!.map((h) => parseInt(h, 16))));

const clip = (s: unknown, n = 8000) => {
  const t = typeof s === "string" ? s : JSON.stringify(s ?? "");
  return t.length > n ? `${t.slice(0, n)}… [${t.length - n} more chars]` : t;
};
export { clip };

// Secret values a build used (registered by vault.ts) never leave in a span.
function scrubAttrs(a: Attrs): Attrs {
  const known: Set<string> | undefined = G.__huddleSecretValues;
  if (!known?.size) return a;
  const out: Attrs = {};
  for (const [k, v] of Object.entries(a)) {
    if (typeof v !== "string") { out[k] = v; continue; }
    let t = v;
    for (const s of known) if (t.includes(s)) t = t.split(s).join("[secret]");
    out[k] = t;
  }
  return out;
}

/** Record a finished span (used for the pipeline root, whose start and end we know afterwards). */
export function emitSpan(s: {
  traceId: string; spanId: string; parentId?: string; name: string; kind: string;
  start: number; end: number; attrs?: Attrs; error?: string;
}) {
  if (!tracing) return;
  spans.push({
    // Arize parses OTLP/JSON ids the protobuf-JSON way (base64 bytes), so send base64 of our hex ids.
    traceId: b64(s.traceId), spanId: b64(s.spanId), parentSpanId: s.parentId ? b64(s.parentId) : undefined, name: s.name, kind: 1,
    startTimeUnixNano: String(Math.round(s.start * 1e6)), endTimeUnixNano: String(Math.round(s.end * 1e6)),
    attributes: otlpAttrs(scrubAttrs({ "openinference.span.kind": s.kind, ...s.attrs })),
    status: s.error ? { code: 2, message: s.error.slice(0, 500) } : { code: 1 },
  });
}

export type SpanHandle = { traceId: string; spanId: string; set: (a: Attrs) => void };

/**
 * Run fn inside a span. kind is the OpenInference span kind: CHAIN, LLM, TOOL, AGENT, EVALUATOR.
 * Pass `ctx` to start in a specific trace (e.g. a pipeline's); otherwise it nests under the current span.
 */
export async function span<T>(name: string, kind: string, attrs: Attrs, fn: (s: SpanHandle) => Promise<T>, ctx?: Ctx): Promise<T> {
  const parent = ctx ?? current();
  const me: Ctx = {
    traceId: parent?.traceId || randomId(16), spanId: randomId(8),
    session: parent?.session, pipelineId: parent?.pipelineId,
  };
  const all: Attrs = { ...attrs };
  if (me.session) all["session.id"] = me.session;
  // metadata is passed as an object; Arize wants it as a JSON string.
  all.metadata = JSON.stringify({ ...(me.pipelineId ? { pipeline_id: me.pipelineId } : {}), ...(attrs.metadata as object ?? {}) });
  const start = Date.now();
  const handle: SpanHandle = { traceId: me.traceId, spanId: me.spanId, set: (a) => Object.assign(all, a) };
  let error: string | undefined;
  try {
    return await als.run(me, () => fn(handle));
  } catch (e) {
    error = String((e as Error)?.message ?? e);
    throw e;
  } finally {
    emitSpan({ traceId: me.traceId, spanId: me.spanId, parentId: parent?.spanId || undefined, name, kind, start, end: Date.now(), attrs: all, error });
  }
}

/** Attach eval scores to a span in Arize (retried until the span has been ingested). */
export function annotate(spanId: string, values: { name: string; score?: number; label?: string; text?: string }[]) {
  if (!tracing || !PROJECT_ID) return;
  notes.push({ spanId, values, tries: 0, due: Date.now() + 20_000 });
}

async function flushSpans() {
  if (!spans.length) return;
  const batch = spans.splice(0, 200);
  try {
    const r = await fetch("https://otlp.arize.com/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/json", space_id: SPACE!, api_key: KEY! },
      body: JSON.stringify({
        resourceSpans: [{
          resource: { attributes: otlpAttrs({ "openinference.project.name": PROJECT, "service.name": "huddle" }) },
          scopeSpans: [{ scope: { name: "huddle" }, spans: batch }],
        }],
      }),
    });
    if (!r.ok) console.error("arize export", r.status, (await r.text()).slice(0, 200));
  } catch (e) {
    console.error("arize export failed", e);
  }
}

async function flushNotes() {
  const now = Date.now();
  for (const n of notes.filter((x) => x.due <= now)) {
    notes.splice(notes.indexOf(n), 1);
    try {
      const r = await fetch("https://api.arize.com/v2/spans/annotate", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ project_id: PROJECT_ID, annotations: [{ record_id: n.spanId, values: n.values }] }),
      });
      // 404 = span not ingested yet; try again for a few minutes.
      if (r.status === 404 && n.tries < 12) notes.push({ ...n, tries: n.tries + 1, due: now + 20_000 });
      else if (!r.ok) console.error("arize annotate", r.status, (await r.text()).slice(0, 200));
    } catch (e) {
      console.error("arize annotate failed", e);
    }
  }
}

if (tracing && !G.__huddleFlush) {
  G.__huddleFlush = setInterval(() => { flushSpans(); flushNotes(); }, 2000);
}
