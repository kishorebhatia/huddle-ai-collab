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

export async function upload(sb: Sandbox, name: string, content: string, base = SITE) {
  const fd = new FormData();
  fd.append("file", new Blob([content]), name.split("/").pop());
  await api(`${sb.toolbox}/files/upload-v2?path=${encodeURIComponent(`${base}/${name}`)}`, { method: "POST", body: fd });
}

/** Free space by deleting Huddle's oldest prototype sandbox (never the scanner, never anything not Huddle's). */
async function evictOldest(): Promise<boolean> {
  const list = await (await api(`${API}/sandbox`)).json();
  // deno-lint-ignore no-explicit-any
  const ours = ((Array.isArray(list) ? list : list.items) ?? []).filter((x: any) =>
    x.labels?.app === "huddle" && x.labels?.role !== "secret-scan" && !["destroying", "destroyed"].includes(x.state))
    .sort((a: { createdAt: string }, b: { createdAt: string }) => a.createdAt.localeCompare(b.createdAt));
  if (!ours.length) return false;
  await api(`${API}/sandbox/${ours[0].id}`, { method: "DELETE" });
  console.log(`daytona: deleted oldest prototype sandbox ${ours[0].id} to stay under the disk limit`);
  await sleep(4000);
  return true;
}

/** A started public sandbox (no site yet). */
export async function deploySandbox(labels: Record<string, string>): Promise<Sandbox> {
  const create = () => api(`${API}/sandbox`, {
    method: "POST", headers: { "content-type": "application/json" },
    // Keep demo links up for two hours of no traffic; delete a day after they stop.
    body: JSON.stringify({ public: true, autoStopInterval: 120, autoDeleteInterval: 1440, labels: { app: "huddle", ...labels } }),
  });
  let res: Response | null = null;
  for (let i = 0; i < 3 && !res; i++) {
    try {
      res = await create();
    } catch (e) {
      // The account has a total disk cap; old prototypes make way for new ones.
      if (!/disk limit|concurrency|quota/i.test(String(e)) || !(await evictOldest())) throw e;
    }
  }
  if (!res) throw new Error("Daytona is out of space for new sandboxes");
  const created = await res.json();
  const id = created.id;
  const base = String(created.toolboxProxyUrl ?? "https://proxy.app.daytona.io/toolbox").replace(/\/$/, "");
  const sb: Sandbox = { id, toolbox: base.endsWith(id) ? base : `${base}/${id}`, url: "" };
  for (let i = 0; i < 40; i++) {
    const st = (await (await api(`${API}/sandbox/${id}`)).json()).state;
    if (st === "started") return sb;
    if (st === "error" || st === "build_failed") throw new Error(`sandbox ${id} ${st}`);
    await sleep(1500);
  }
  throw new Error(`sandbox ${id} did not start`);
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
    const sb = await deploySandbox(labels);
    const id = sb.id;
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

// ---------- apps with a backend ----------
const APP = "/home/daytona/app";
export type App = Sandbox & { cmdId?: string };

/** (Re)start `node server.js` with the secrets from .env, which exists only inside the sandbox. */
export async function startApp(app: App) {
  await api(`${app.toolbox}/process/session`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "app" }),
  }).catch(() => null); // already exists after the first start
  await exec(app, `bash -lc "pkill -f 'node --env-file' || true"`, 20);
  const r = await (await api(`${app.toolbox}/process/session/app/exec`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ command: `cd ${APP} && PORT=${PORT} node --env-file=.env server.js`, runAsync: true }),
  })).json();
  app.cmdId = r.cmdId;
  for (let i = 0; i < 20; i++) {
    const res = await fetch(app.url || "http://invalid", { signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (res && res.status < 500) return;
    await sleep(1500);
  }
}

/** The server's stdout/stderr, for repairs. */
export async function appLogs(app: App): Promise<string> {
  if (!app.cmdId) return "";
  const r = await fetch(`${app.toolbox}/process/session/app/command/${app.cmdId}/logs`, { headers: auth, signal: AbortSignal.timeout(15000) }).catch(() => null);
  return r?.ok ? (await r.text()).slice(-4000) : "";
}

/** Upload an app's files plus a .env with its secrets, start it, and return its public URL. */
export function deployApp(files: Record<string, string>, env: Record<string, string>, labels: Record<string, string>): Promise<App> {
  return span("daytona.deploy_app", "TOOL", { "tool.name": "daytona.deploy_app", "input.value": `${Object.keys(files).join(", ")}\nenv: ${Object.keys(env).join(", ") || "none"}` }, async (s) => {
    const app: App = await deploySandbox(labels);
    await uploadApp(app, files, env);
    app.url = (await (await api(`${API}/sandbox/${app.id}/ports/${PORT}/preview-url`)).json()).url;
    await startApp(app);
    s.set({ "output.value": app.url, metadata: { sandbox_id: app.id } });
    return app;
  });
}

/** Upload files; pass env only on the first deploy (repairs must not touch the sandbox's .env). */
export async function uploadApp(app: App, files: Record<string, string>, env?: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) if (!/(^|\/)\.env$/.test(path)) await upload(app, path, content, APP);
  if (env) await upload(app, ".env", Object.entries(env).map(([k, v]) => `${k}=${v.replace(/[\r\n]/g, "")}`).join("\n") + "\n", APP);
}

/** node --check on the server and on every inline script in the UI. */
export async function checkApp(app: App, files: Record<string, string>): Promise<{ ok: boolean; log: string }> {
  const inline = await checkScripts(app, files["public/index.html"] ?? "");
  const r = await exec(app, `bash -lc "cd ${APP} && node --check server.js && echo SERVER_OK"`, 60);
  return { ok: inline.ok && r.exitCode === 0, log: `${r.result ?? ""}\n${inline.ok ? "" : inline.log}`.trim().slice(0, 3000) };
}
