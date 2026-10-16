// Daytona: a sandbox per published prototype. We upload the files, check the scripts with Node inside
// the sandbox, serve the site, and hand back Daytona's public preview URL. Needs DAYTONA_API_KEY.
import { clip, span } from "./trace.ts";

const API = "https://app.daytona.io/api";
const KEY = Deno.env.get("DAYTONA_API_KEY");
export const daytonaOn = () => !!KEY;
const auth = { authorization: `Bearer ${KEY}` };
const SITE = "/home/daytona/site";
const PORT = 3000;

export type Sandbox = { id: string; toolbox: string; url: string };

async function api(url: string, init: RequestInit = {}, timeoutMs = 60_000) {
  const r = await fetch(url, {
    ...init, headers: { ...auth, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`Daytona ${new URL(url).pathname} ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function upload(sb: Sandbox, name: string, content: string) {
  const fd = new FormData();
  fd.append("file", new Blob([content]), name);
  await api(`${sb.toolbox}/files/upload-v2?path=${encodeURIComponent(`${SITE}/${name}`)}`, { method: "POST", body: fd });
}

export function exec(sb: Sandbox, command: string, timeout = 60): Promise<{ exitCode: number; result: string }> {
  return span("daytona.execute", "TOOL", { "tool.name": "daytona.process.execute", "input.value": command }, async (s) => {
    const r = await api(`${sb.toolbox}/process/execute`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command, timeout }),
    }, (timeout + 15) * 1000);
    const out = await r.json();
    s.set({ "output.value": clip(`exit ${out.exitCode}\n${out.result ?? ""}`, 4000) });
    return out;
  });
}

/** Create a public sandbox, upload the site and serve it. Returns the public preview URL. */
export function deploySite(files: Record<string, string>, labels: Record<string, string>): Promise<Sandbox> {
  return span("daytona.deploy", "TOOL", { "tool.name": "daytona.deploy", "input.value": Object.keys(files).join(", ") }, async (s) => {
    const created = await (await api(`${API}/sandbox`, {
      method: "POST", headers: { "content-type": "application/json" },
      // Keep demo links up for two hours of no traffic; delete a day after they stop.
      body: JSON.stringify({ public: true, autoStopInterval: 120, autoDeleteInterval: 1440, labels: { app: "huddle", ...labels } }),
    })).json();
    const id = created.id;
    const base = String(created.toolboxProxyUrl ?? "https://proxy.app.daytona.io/toolbox").replace(/\/$/, "");
    const sb: Sandbox = { id, toolbox: base.endsWith(id) ? base : `${base}/${id}`, url: "" };
    for (let i = 0; i < 40; i++) {
      const st = (await (await api(`${API}/sandbox/${id}`)).json()).state;
      if (st === "started") break;
      if (st === "error" || st === "build_failed") throw new Error(`sandbox ${id} ${st}`);
      await sleep(1500);
    }
    for (const [name, content] of Object.entries(files)) await upload(sb, name, content);
    await api(`${sb.toolbox}/process/session`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "web" }),
    });
    await api(`${sb.toolbox}/process/session/web/exec`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: `cd ${SITE} && python3 -m http.server ${PORT}`, runAsync: true }),
    });
    sb.url = (await (await api(`${API}/sandbox/${id}/ports/${PORT}/preview-url`)).json()).url;
    for (let i = 0; i < 20; i++) {
      const r = await fetch(sb.url, { signal: AbortSignal.timeout(5000) }).catch(() => null);
      if (r?.ok) break;
      await sleep(1500);
    }
    s.set({ "output.value": sb.url, metadata: { sandbox_id: id } });
    return sb;
  });
}

/** Syntax-check every inline <script> with Node inside the sandbox. */
export async function checkScripts(sb: Sandbox, html: string): Promise<{ ok: boolean; log: string }> {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((m) => m[2].trim() && !/type=["']?(application\/(ld\+)?json|text\/(template|x-template|babel))/i.test(m[1]))
    .map((m, i) => ({ name: `check/s${i}.${/type=["']?module/i.test(m[1]) ? "mjs" : "js"}`, code: m[2] }));
  if (!scripts.length) return { ok: true, log: "no inline scripts" };
  for (const s of scripts) await upload(sb, s.name, s.code);
  const cmd = scripts.map((s) => `node --check ${SITE}/${s.name}`).join(" && ");
  const r = await exec(sb, `bash -lc "${cmd} && echo ALL_OK"`, 60);
  return { ok: r.exitCode === 0, log: (r.result ?? "").slice(0, 3000) };
}
