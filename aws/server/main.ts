// Huddle gateway for AWS: one Deno process that speaks the Supabase wire protocols the app already uses,
// so web/app.js (supabase-js) and supabase/functions/* run unchanged on a plain EC2 + Postgres box.
//
//   /rest/v1/*                      → PostgREST
//   /functions/v1/<name>            → supabase/functions/<name>/index.ts, loaded in-process
//   /storage/v1/object/...          → files on local disk (public bucket "board")
//   /realtime/v1/websocket          → Phoenix-protocol subset: postgres_changes, presence, broadcast
//   /config.js                      → browser config (same origin + anon key)
//   everything else                 → web/
import postgres from "npm:postgres@3.4.5";
import { serveDir } from "jsr:@std/http@1.0.12/file-server";
import { clip, emitSpan, pipelineCtx, span, type Ctx } from "../../supabase/functions/_shared/trace.ts";
import { caller } from "../../supabase/functions/_shared/auth.ts";
import { handleAuth } from "./auth.ts";
import { redactPatterns } from "../../supabase/functions/_shared/secrets.ts";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const PORT = Number(env("PORT", "8080"));
const REST = env("POSTGREST_URL", "http://127.0.0.1:3000");
const STORAGE = env("STORAGE_DIR", "/data/storage");
const ROOT = new URL("../../", import.meta.url).pathname;
const ANON_KEY = env("SUPABASE_ANON_KEY");

const sql = postgres(env("DATABASE_URL"), { max: 5 });

// ---------- functions: load each Deno.serve handler in-process ----------
type Handler = (req: Request) => Response | Promise<Response>;
const handlers = new Map<string, Handler>();

async function loadFunctions() {
  const src = `${ROOT}supabase/functions`;
  const out = await Deno.makeTempDir({ prefix: "fns" });
  await Deno.mkdir(`${out}/_shared`);
  for await (const f of Deno.readDir(`${src}/_shared`)) {
    await Deno.copyFile(`${src}/_shared/${f.name}`, `${out}/_shared/${f.name}`);
  }
  for await (const d of Deno.readDir(src)) {
    if (!d.isDirectory || d.name.startsWith("_")) continue;
    const code = await Deno.readTextFile(`${src}/${d.name}/index.ts`);
    await Deno.mkdir(`${out}/${d.name}`);
    // Each function ends in Deno.serve(handler); export the handler instead.
    await Deno.writeTextFile(`${out}/${d.name}/index.ts`, code.replace(/Deno\.serve\(/, "export default ("));
    try {
      const mod = await import(`file://${out}/${d.name}/index.ts`);
      handlers.set(d.name, mod.default);
    } catch (e) {
      console.error(`function ${d.name} failed to load`, e);
    }
  }
  console.log(`functions: ${[...handlers.keys()].join(", ")}`);
}

// ---------- realtime ----------
type Binding = { id: number; event: string; schema: string; table: string; filter?: string };
type Chan = { topic: string; joinRef: string; bindings: Binding[]; presenceKey: string; self: boolean; room: string; token: string };
type Client = { ws: WebSocket; chans: Map<string, Chan> };
const clients = new Set<Client>();
const presence = new Map<string, Map<string, { client: Client; meta: Record<string, unknown> }>>();
let bindingSeq = 1;
let refSeq = 1;

const send = (c: Client, topic: string, event: string, payload: unknown, ref: string | null = null) => {
  if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify({ topic, event, payload, ref }));
};
const metasOf = (key: string, meta: Record<string, unknown>) => ({ [key]: { metas: [meta] } });

function presenceLeave(c: Client, topic: string) {
  const room = presence.get(topic);
  if (!room) return;
  for (const [key, p] of room) {
    if (p.client !== c) continue;
    room.delete(key);
    for (const o of clients) if (o.chans.has(topic)) send(o, topic, "presence_diff", { joins: {}, leaves: metasOf(key, p.meta) });
  }
}

function onMessage(c: Client, raw: string) {
  const { topic, event, payload, ref } = JSON.parse(raw);
  const reply = (response: unknown = {}) => send(c, topic, "phx_reply", { status: "ok", response }, ref);
  if (topic === "phoenix") return reply();
  if (event === "phx_join") {
    join(c, topic, payload, ref).catch((e) => console.error("join", e));
    return;
  }
  const ch = c.chans.get(topic);
  if (!ch) return reply();
  if (event === "access_token") { ch.token = String(payload?.access_token ?? ""); return reply(); }
  return onChannelMessage(c, ch, topic, event, payload, reply);
}

// Channels are named db-<room> and room-<room>; private rooms only admit their owner and members.
const roomOfTopic = (topic: string) => topic.match(/^realtime:(?:db|room)-(.+)$/)?.[1] ?? "";

async function join(c: Client, topic: string, payload: Record<string, any>, ref: string) {
  const room = roomOfTopic(topic);
  const token = String(payload?.access_token ?? "");
  if (room && !(await canSee(room, `Bearer ${token}`))) {
    return send(c, topic, "phx_reply", { status: "error", response: { reason: "This huddle is private" } }, ref);
  }
  {
    const cfg = payload?.config ?? {};
    const bindings = (cfg.postgres_changes ?? []).map((b: Omit<Binding, "id">) => ({ ...b, id: bindingSeq++ }));
    c.chans.set(topic, { topic, joinRef: ref, bindings, presenceKey: cfg.presence?.key || crypto.randomUUID(), self: !!cfg.broadcast?.self, room, token });
    send(c, topic, "phx_reply", { status: "ok", response: { postgres_changes: bindings } }, ref);
    const here = presence.get(topic);
    const state: Record<string, unknown> = {};
    for (const [k, p] of here ?? []) state[k] = { metas: [p.meta] };
    send(c, topic, "presence_state", state);
  }
}

// deno-lint-ignore no-explicit-any
function onChannelMessage(c: Client, ch: Chan, topic: string, event: string, payload: any, reply: (r?: unknown) => void) {
  if (event === "phx_leave") { presenceLeave(c, topic); c.chans.delete(topic); return reply(); }
  if (event === "presence") {
    if (!presence.has(topic)) presence.set(topic, new Map());
    const room = presence.get(topic)!;
    const prev = room.get(ch.presenceKey);
    if (payload?.event === "track") {
      const meta = { ...(payload.payload ?? {}), phx_ref: String(refSeq++) };
      room.set(ch.presenceKey, { client: c, meta });
      for (const o of clients) if (o.chans.has(topic)) {
        send(o, topic, "presence_diff", { joins: metasOf(ch.presenceKey, meta), leaves: prev ? metasOf(ch.presenceKey, prev.meta) : {} });
      }
    } else if (payload?.event === "untrack" && prev) {
      room.delete(ch.presenceKey);
      for (const o of clients) if (o.chans.has(topic)) send(o, topic, "presence_diff", { joins: {}, leaves: metasOf(ch.presenceKey, prev.meta) });
    }
    return reply();
  }
  if (event === "broadcast") {
    for (const o of clients) if (o.chans.has(topic) && (o !== c || ch.self)) send(o, topic, "broadcast", payload);
    return reply();
  }
  reply(); // access_token and anything else
}

function matches(b: Binding, table: string, op: string, row: Record<string, unknown>) {
  if (b.table !== table || (b.schema && b.schema !== "public")) return false;
  if (b.event !== "*" && b.event?.toUpperCase() !== op) return false;
  if (!b.filter) return true;
  const m = b.filter.match(/^(\w+)=eq\.(.*)$/);
  return !m || String(row[m[1]]) === m[2];
}

const PK: Record<string, string> = { brain: "room_id" };
async function onChange(msg: string) {
  const { t, op, pk } = JSON.parse(msg);
  if (![...clients].some((c) => [...c.chans.values()].some((ch) => ch.bindings.some((b) => b.table === t)))) return;
  let row: Record<string, unknown> = { [PK[t] ?? "id"]: pk };
  if (op !== "DELETE") {
    const rows = await sql`select row_to_json(x) as r from ${sql("public." + t)} x where ${sql(PK[t] ?? "id")}::text = ${pk}`;
    if (!rows.length) return;
    row = rows[0].r;
  }
  if (t === "pipelines") pipelineRoot(row).catch((e) => console.error("root span", e));
  if (t === "rooms" && row.visibility === "private") evictOutsiders(String(row.id)).catch((e) => console.error("evict", e));
  const data = {
    schema: "public", table: t, type: op, commit_timestamp: new Date().toISOString(), columns: [], errors: null,
    record: op === "DELETE" ? {} : row, old_record: op === "DELETE" ? row : {},
  };
  for (const c of clients) for (const ch of c.chans.values()) {
    const ids = ch.bindings.filter((b) => matches(b, t, op, row)).map((b) => b.id);
    if (ids.length) send(c, ch.topic, "postgres_changes", { ids, data });
  }
}

// ---------- storage ----------
const safePath = (p: string) => decodeURIComponent(p).split("/").filter((s) => s && s !== "." && s !== "..").join("/");

async function storage(req: Request, path: string): Promise<Response> {
  let m = path.match(/^\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/);
  if (m && (req.method === "GET" || req.method === "HEAD")) {
    const file = `${STORAGE}/${safePath(m[1])}/${safePath(m[2])}`;
    try {
      const meta = JSON.parse(await Deno.readTextFile(`${file}.meta.json`).catch(() => "{}"));
      const f = await Deno.open(file);
      return new Response(req.method === "HEAD" ? null : f.readable, {
        headers: { "content-type": meta.contentType ?? "application/octet-stream", "cache-control": "public, max-age=31536000", "access-control-allow-origin": "*" },
      });
    } catch { return new Response("not found", { status: 404 }); }
  }
  m = path.match(/^\/storage\/v1\/object\/([^/]+)\/(.+)$/);
  if (m && (req.method === "POST" || req.method === "PUT")) {
    const key = `${safePath(m[1])}/${safePath(m[2])}`;
    const file = `${STORAGE}/${key}`;
    await Deno.mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true });
    let bytes = new Uint8Array(await req.arrayBuffer());
    let contentType = req.headers.get("content-type") ?? "application/octet-stream";
    // storage-js wraps Blobs in FormData (file field named "") and may label the request with the file's own
    // type, so find the part with a filename by hand.
    // One char per byte (windows-1252 keeps length), so string offsets are byte offsets.
    const latin = (b: Uint8Array) => new TextDecoder("latin1").decode(b);
    const head = latin(bytes.subarray(0, 300));
    if (head.startsWith("--") && head.includes("Content-Disposition: form-data")) {
      const all = latin(bytes);
      const boundary = "\r\n" + head.slice(0, head.indexOf("\r\n"));
      for (const seg of all.split(boundary)) {
        const split = seg.indexOf("\r\n\r\n");
        const headers = seg.slice(0, split);
        if (split < 0 || !/filename=/i.test(headers)) continue;
        const start = all.indexOf(seg) + split + 4;
        bytes = bytes.slice(start, start + seg.length - split - 4);
        contentType = headers.match(/Content-Type:\s*([^\r\n]+)/i)?.[1] ?? "application/octet-stream";
        break;
      }
    }
    await Deno.writeFile(file, bytes);
    await Deno.writeTextFile(`${file}.meta.json`, JSON.stringify({ contentType }));
    return Response.json({ Key: key, Id: crypto.randomUUID() });
  }
  return new Response("not found", { status: 404 });
}

// ---------- private rooms ----------
// RLS guards REST reads; these guard what RLS can't see: function calls and realtime fan-out.
async function canSee(room: string, authorization: string | null) {
  const who = await caller(new Request("http://local", { headers: { authorization: authorization ?? "" } }));
  if (who.service) return true;
  const r = await sql`select visibility, owner_id from public.rooms where id = ${room}`;
  if (!r.length || r[0].visibility !== "private") return true;
  if (!who.uid) return false;
  if (Number(r[0].owner_id) === who.uid) return true;
  return (await sql`select 1 from public.room_members where room_id = ${room} and user_id = ${who.uid}`).length > 0;
}

/** A room just went private: drop realtime subscribers who aren't allowed in any more. */
async function evictOutsiders(room: string) {
  for (const c of clients) for (const ch of [...c.chans.values()]) {
    if (ch.room !== room || await canSee(room, `Bearer ${ch.token}`)) continue;
    presenceLeave(c, ch.topic);
    c.chans.delete(ch.topic);
    send(c, ch.topic, "phx_close", {});
  }
}

// ---------- tracing ----------
// Each function call is a span. Pipeline work joins its pipeline's trace; everything else gets its own
// trace in the room's session, so Arize groups a room's activity together.
async function traced(name: string, req: Request, h: Handler): Promise<Response> {
  // deno-lint-ignore no-explicit-any
  let body: any = {};
  try { body = JSON.parse(await req.clone().text()); } catch { /* not JSON */ }
  let pid = Number(body.pipeline_id) || undefined;
  let room: string | undefined = body.room;
  if (!pid && body.job_id) {
    const r = await sql`select pipeline_id, room_id from public.jobs where id = ${Number(body.job_id)}`;
    pid = r[0]?.pipeline_id ?? undefined;
    room ??= r[0]?.room_id;
  }
  if (pid && !room) room = (await sql`select room_id from public.pipelines where id = ${pid}`)[0]?.room_id;
  if (name === "eval-run") room = "ci";
  else if (room && !(await canSee(room, req.headers.get("authorization")))) {
    return new Response(JSON.stringify({ error: "This huddle is private" }), { status: 403, headers: { "content-type": "application/json" } });
  }
  const ctx: Ctx = pid ? await pipelineCtx(pid, room) : { traceId: "", spanId: "", session: room };
  const input = { ...body };
  if (typeof input.audio === "string") input.audio = `[${input.audio.length} chars of audio]`;
  if (typeof input.system === "string") input.system = clip(input.system, 2000);
  if ("value" in input) input.value = "[secret]"; // the secrets function: never trace a key
  return await span(`fn.${name}`, "CHAIN", { "input.value": clip(input), "input.mime_type": "application/json", "user.id": body.author, metadata: { function: name } }, async (s) => {
    const res = await h(req);
    s.set({ "output.value": clip(await res.clone().text().catch(() => ""), 4000), "output.mime_type": "application/json", "http.status_code": res.status });
    return res;
  }, ctx);
}

// The root span of a pipeline's trace, sent once it finishes (now we know its start and end).
const rootsSent = new Set<string>();
async function pipelineRoot(p: Record<string, unknown>) {
  if (!["done", "failed", "stopped"].includes(String(p.status))) return;
  const key = `${p.id}:${p.status}`;
  if (rootsSent.has(key)) return;
  rootsSent.add(key);
  const ctx = await pipelineCtx(Number(p.id), String(p.room_id));
  emitSpan({
    traceId: ctx.traceId, spanId: ctx.spanId, name: `pipeline: ${p.title}`, kind: "AGENT",
    start: Date.parse(String(p.created_at)), end: Date.parse(String(p.updated_at)),
    error: p.status === "failed" ? "pipeline failed" : undefined,
    attrs: {
      "input.value": String(p.goal ?? ""), "output.value": String(p.host_url ?? p.status), "session.id": String(p.room_id),
      metadata: JSON.stringify({ pipeline_id: p.id, stages: p.stages, status: p.status, host_url: p.host_url }),
    },
  });
}

// ---------- http ----------
// Keys pasted into the stream or the board are redacted before they are stored, so they never reach
// the brief, a prompt, a trace or a repository.
// deno-lint-ignore no-explicit-any
function redactDeep(v: any): any {
  if (typeof v === "string") return redactPatterns({ v }).files.v;
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)]));
  return v;
}

async function proxyRest(req: Request, url: URL) {
  const target = `${REST}${url.pathname.slice("/rest/v1".length) || "/"}${url.search}`;
  const headers = new Headers(req.headers);
  headers.delete("host");
  let body: BodyInit | null = req.body;
  if (["POST", "PATCH"].includes(req.method) && /^\/rest\/v1\/(events|board_items)\b/.test(url.pathname)) {
    const text = await req.text();
    try { body = JSON.stringify(redactDeep(JSON.parse(text))); } catch { body = text; }
    headers.delete("content-length");
  }
  const r = await fetch(target, { method: req.method, headers, body, redirect: "manual" });
  const out = new Headers(r.headers);
  out.set("access-control-allow-origin", "*");
  return new Response(r.body, { status: r.status, headers: out });
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type, prefer, range, accept-profile, content-profile, x-upsert, cache-control",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD",
};

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;
  if (p === "/realtime/v1/websocket") {
    const { socket, response } = Deno.upgradeWebSocket(req);
    const c: Client = { ws: socket, chans: new Map() };
    socket.onopen = () => clients.add(c);
    socket.onmessage = (e) => { try { onMessage(c, String(e.data)); } catch (err) { console.error("ws", err); } };
    socket.onclose = () => { for (const t of c.chans.keys()) presenceLeave(c, t); clients.delete(c); };
    return response;
  }
  if (req.method === "OPTIONS" && !p.startsWith("/functions/")) return new Response(null, { headers: CORS });
  if (p.startsWith("/rest/v1")) return proxyRest(req, url);
  if (p.startsWith("/storage/v1/")) return storage(req, p);
  if (p.startsWith("/auth/")) {
    const res = await handleAuth(req, url, sql);
    if (res) return res;
  }
  const fm = p.match(/^\/functions\/v1\/([\w-]+)/);
  if (fm) {
    const h = handlers.get(fm[1]);
    if (!h) return new Response(JSON.stringify({ error: `no function ${fm[1]}` }), { status: 404 });
    if (req.method !== "POST") {
      const room = url.searchParams.get("room");
      if (room && req.method === "GET" && !(await canSee(room, req.headers.get("authorization")))) {
        return new Response(JSON.stringify({ error: "This huddle is private" }), { status: 403 });
      }
      return await h(req);
    }
    return await traced(fm[1], req, h);
  }
  if (p === "/config.js") {
    return new Response(
      `export const SUPABASE_URL = location.origin;\nexport const SUPABASE_KEY = ${JSON.stringify(ANON_KEY)};\n` +
        // No Gemini key → no server speech model; browsers transcribe with their own speech recognition.
        `export const SPEECH = ${JSON.stringify(env("GEMINI_API_KEY") ? "server" : "browser")};\n` +
        `export const ARIZE_PROJECT_URL = ${JSON.stringify(env("ARIZE_PROJECT_URL"))};\n` +
        `export const GITHUB_SIGNIN = ${JSON.stringify(!!env("GITHUB_CLIENT_ID"))};\n`,
      { headers: { "content-type": "text/javascript", "cache-control": "no-store" } },
    );
  }
  if (p === "/healthz") return Response.json({ ok: true, functions: [...handlers.keys()], sockets: clients.size });
  return serveDir(req, { fsRoot: `${ROOT}web`, quiet: true });
}

await loadFunctions();
await sql.listen("huddle_changes", (m) => onChange(m).catch((e) => console.error("change", e)));

// Replaces the pg_cron sweep: restart stalled pipelines and fail dead jobs every minute.
setInterval(() => {
  const h = handlers.get("orchestrate");
  if (!h) return;
  Promise.resolve(h(new Request("http://local/functions/v1/orchestrate", { method: "POST", headers: { "content-type": "application/json" }, body: '{"sweep":true}' })))
    .catch((e: unknown) => console.error("sweep", e));
}, 60_000);

Deno.serve({ port: PORT, hostname: "0.0.0.0" }, (req) => handle(req).catch((e) => {
  console.error(e);
  return Response.json({ error: String(e?.message ?? e) }, { status: 500 });
}));
