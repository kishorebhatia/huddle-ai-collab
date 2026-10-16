// POST { job_id } -> runs one job (research | review | prototype | host) in the background.
// Status streams back via Realtime; pipeline jobs hand control back to the orchestrator when done.
import { background, cors, db, FAST_MODEL, gemini, geminiJson, json, SMART_MODEL } from "../_shared/util.ts";
import { invokeFn } from "../_shared/pipeline.ts";
import { APP_SYSTEM, CHANGE_SYSTEM, IMPROVE_SYSTEM, LOCATE_SCHEMA, PROTOTYPE_SYSTEM, RESEARCH_SYSTEM, REVIEW_SCHEMA, REVIEW_SYSTEM, TRIAGE_SCHEMA, TRIAGE_SYSTEM } from "../_shared/prompts.ts";
import {
  adminToken, applyChange, currentPrompts, evidence, mergePr, openPr, openPrFiles, PROMPTS_PATH, readFiles, repoTree, revertMerge,
  sensitiveFiles, typeCheck, verifyChange, waitForChecks, waitForDeploy,
} from "../_shared/operator.ts";
import { planGoal, planMarkdown, type Plan } from "../_shared/plan.ts";
import { resolveSecrets } from "../_shared/vault.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { lessonsFor, recordEval, judgeGrounding } from "../_shared/evals.ts";
import { anchorOn, closeSession, openSession, readPage, screenshot, smokeTest } from "../_shared/anchor.ts";
import { appLogs, checkApp, checkScripts, daytonaOn, deployApp, deploySite, startApp, upload, uploadApp, type Sandbox } from "../_shared/daytona.ts";
import { current, span } from "../_shared/trace.ts";

/** Files from ```file:<path> blocks (the app builder's output format). */
function extractFiles(text: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const m of text.matchAll(/```file:([^\s`]+)\s*\n([\s\S]*?)```/g)) {
    const path = m[1].replace(/^\/+/, "").replace(/\.\.\//g, "");
    if (path && !/(^|\/)\.env/.test(path)) files[path] = m[2].replace(/\n$/, "");
  }
  return files;
}
const filesBlock = (files: Record<string, string>) =>
  Object.entries(files).map(([p, c]) => `\`\`\`file:${p}\n${c}\n\`\`\``).join("\n\n");

function extractHtml(text: string) {
  const fenced = text.match(/```html\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const start = text.search(/<!doctype html|<html/i);
  if (start >= 0) {
    const end = text.toLowerCase().lastIndexOf("</html>");
    return text.slice(start, end > start ? end + 7 : undefined).trim();
  }
  return null;
}

const now = () => new Date().toISOString();

/** Everything an agent should know: the brief, the recent conversation, and earlier stage outputs. */
async function contextPack(sb: SupabaseClient, job: any) {
  const { data: brain } = await sb.from("brain").select("state").eq("room_id", job.room_id).maybeSingle();
  const s = brain?.state ?? {};
  const { data: recent } = await sb.from("events").select("id, author, kind, text")
    .eq("room_id", job.room_id).neq("kind", "system").eq("forgotten", false).order("id", { ascending: false }).limit(40);
  const convo = (recent ?? []).reverse()
    .map((e) => `[#${e.id} ${e.author} ${e.kind}] ${(e.text ?? "").slice(0, 600)}`).join("\n");

  let stageInputs = "";
  let previous: any = null;
  if (job.pipeline_id) {
    const { data: done } = await sb.from("jobs").select("id, kind, stage_index, output_md, output_html, files, sources")
      .eq("pipeline_id", job.pipeline_id).eq("status", "done").order("id");
    const prior = (done ?? []).filter((j) => j.stage_index < job.stage_index);
    const lastOf = (k: string) => [...prior].reverse().find((j) => j.kind === k);
    previous = [...prior].reverse().find((j) => j.stage_index === job.stage_index - 1) ?? null;
    const research = lastOf("research");
    if (research && job.kind !== "research") {
      stageInputs += `\n\nRESEARCH FROM EARLIER STAGE:\n${research.output_md ?? ""}`;
    }
  }
  const text =
    `TEAM GOAL: ${s.goal ?? "(not set)"}\nWHERE THINGS STAND: ${s.summary ?? ""}\n` +
    `DECISIONS: ${(s.decisions ?? []).map((d: any) => d.text).join("; ") || "(none)"}\n\n` +
    `RECENT CONVERSATION (transcripts, notes, sketches, findings):\n${convo || "(none)"}` + stageInputs;
  return { text, previous };
}

async function deployToVercel(html: string, name: string): Promise<string> {
  const token = Deno.env.get("VERCEL_TOKEN");
  const team = Deno.env.get("VERCEL_TEAM_ID");
  if (!token) throw new Error("VERCEL_TOKEN secret is not set");
  const q = team ? `?teamId=${team}` : "";
  const r = await fetch(`https://api.vercel.com/v13/deployments${q}${q ? "&" : "?"}skipAutoDetectionConfirmation=1`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      name, target: "production", projectSettings: { framework: null },
      files: [{ file: "index.html", data: html }],
    }),
  });
  const dep = await r.json();
  if (!r.ok) throw new Error(`Vercel ${r.status}: ${JSON.stringify(dep).slice(0, 300)}`);
  for (let i = 0; i < 30; i++) {
    const g = await fetch(`https://api.vercel.com/v13/deployments/${dep.id}${q}`, { headers: { authorization: `Bearer ${token}` } });
    const d = await g.json();
    if (d.readyState === "READY") {
      // Prefer the short production alias (project.vercel.app) over the team-suffixed one.
      const aliases: string[] = d.alias ?? [];
      const alias = aliases.find((a) => a === `${name}.vercel.app`) ?? aliases.find((a) => a.endsWith(".vercel.app")) ?? d.url;
      return `https://${alias}`;
    }
    if (d.readyState === "ERROR" || d.readyState === "CANCELED") throw new Error(`Vercel deploy ${d.readyState}`);
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error("Vercel deploy did not finish in 60 s");
}

async function setMeta(sb: SupabaseClient, jobId: number, patch: Record<string, unknown>) {
  const { data } = await sb.from("jobs").select("meta").eq("id", jobId).maybeSingle();
  await sb.from("jobs").update({ meta: { ...(data?.meta ?? {}), ...patch } }).eq("id", jobId);
}

/** After a deploy: is the live site up, serving the app, and answering its health check? */
async function liveCheck(): Promise<{ ok: boolean; note: string }> {
  const site = (Deno.env.get("PUBLIC_SITE_URL") ?? "").replace(/\/$/, "");
  if (!site) return { ok: true, note: "no public URL configured" };
  await new Promise((r) => setTimeout(r, 15_000)); // let the restarted server settle
  const get = (p: string) => fetch(`${site}${p}`, { signal: AbortSignal.timeout(15_000) }).then(async (r) => ({ ok: r.ok, text: await r.text() })).catch(() => ({ ok: false, text: "" }));
  const [h, page, js] = await Promise.all([get("/healthz"), get("/?room=demo"), get("/app.js")]);
  const fns = (() => { try { return JSON.parse(h.text).functions?.length ?? 0; } catch { return 0; } })();
  const ok = h.ok && fns >= 10 && page.ok && /<title>/i.test(page.text) && js.ok && js.text.length > 1000;
  return { ok, note: `health ${h.ok ? "ok" : "down"}, ${fns} functions, page ${page.ok ? "ok" : "down"}, app.js ${js.ok ? "ok" : "down"}` };
}

/** Store a file in the public "board" bucket and return its URL. */
async function store(path: string, bytes: Uint8Array, type: string) {
  const base = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const r = await fetch(`${base}/storage/v1/object/board/${path}`, {
    method: "POST", headers: { "content-type": type, authorization: `Bearer ${key}`, apikey: key }, body: bytes,
  });
  if (!r.ok) throw new Error(`storage ${r.status}`);
  return `${(Deno.env.get("PUBLIC_SITE_URL") ?? base ?? "").replace(/\/$/, "")}/storage/v1/object/public/board/${path}`;
}

/** Anchor reads the top sources in a real browser; a judge checks the brief against them. */
async function verifyResearch(job: any, text: string, sources: { title: string; url: string }[]) {
  const top = sources.slice(0, 3);
  const read = await Promise.allSettled(top.map((s) => readPage(s.url)));
  const pages = top.map((s, i) => ({ url: s.url, text: read[i].status === "fulfilled" ? (read[i] as PromiseFulfilledResult<string>).value : "" }))
    .filter((p) => p.text.length > 200);
  if (!pages.length) return { note: "\n\n> Anchor couldn't open the source pages, so this brief is unverified.", read: [] as string[] };
  const v = await judgeGrounding(text, pages);
  await recordEval({
    name: "groundedness", score: v.score, explanation: v.explanation, room: job.room_id,
    jobId: job.id, pipelineId: job.pipeline_id ?? undefined, stage: "research", task: job.prompt,
  });
  const unsupported = Array.isArray(v.unsupported_claims) ? (v.unsupported_claims as unknown[]).map(String) : [];
  const note = `\n\n### Checked by Anchor\nRead ${pages.length} source page${pages.length > 1 ? "s" : ""} in a cloud browser. ` +
    `Groundedness ${v.score.toFixed(2)}: ${v.explanation}` +
    (unsupported.length ? `\n\nNot found in the sources:\n${unsupported.slice(0, 5).map((c) => `- ${c}`).join("\n")}` : "");
  return { note, read: pages.map((p) => p.url) };
}

/** Anchor uses the live prototype like a person would; the room can watch it in the live view. */
async function smoke(sb: SupabaseClient, job: any, url: string, goal: string, summary: string) {
  const session = await openSession(url);
  await setMeta(sb, job.id, { live_view_url: session.liveViewUrl, anchor_session: session.id });
  try {
    const res = await smokeTest(session.id,
      `You are QA-testing a web prototype that is already open. It was built for: ${goal.slice(0, 500)}\n` +
      `What it should do: ${summary.slice(0, 400)}\n` +
      `Try its core interaction the way a first-time user would (type, click, filter, etc.). ` +
      `If it uses server-side keys, they are already configured and you don't know their values: don't try to guess secrets. ` +
      `Messages like "not configured", "missing API key" or a failed API call mean it is broken; a sensible answer to your input means it works. ` +
      `Report whether it actually works, what you did, what you saw, and any problems (errors, blank areas, controls that do nothing).`);
    let shot = "";
    try {
      shot = await store(`${job.room_id}/smoke/${job.id}-${Date.now()}.png`, await screenshot(session.id), "image/png");
    } catch (e) { console.warn("screenshot", e); }
    return { ...res, shot };
  } finally {
    await closeSession(session.id);
  }
}

/** Publish on Daytona: Node checks the scripts in the sandbox, Anchor tests the live URL, one repair if either fails. */
async function hostOnDaytona(sb: SupabaseClient, job: any, proto: any, goal: string) {
  let html: string = proto.output_html;
  const summary: string = proto.output_md ?? "";
  const sandbox: Sandbox = await deploySite({ "index.html": html }, { room: String(job.room_id).slice(0, 60), pipeline: String(job.pipeline_id ?? "") });
  await setMeta(sb, job.id, { sandbox_id: sandbox.id, sandbox_url: sandbox.url });
  for (let attempt = 0; ; attempt++) {
    const check = await checkScripts(sandbox, html);
    await recordEval({
      name: "build_success", score: check.ok ? 1 : 0, room: job.room_id, jobId: job.id, pipelineId: job.pipeline_id,
      explanation: check.ok ? `Scripts pass node --check in the Daytona sandbox${attempt ? " after one repair" : ""}.` : `node --check failed: ${check.log.slice(0, 400)}`,
      task: goal,
    });
    const t = await smoke(sb, job, sandbox.url, goal, summary).catch((e) => {
      // No browser available is not a broken prototype: publish, and say the test didn't run.
      console.error("smoke test", e);
      return null;
    });
    if (!t) {
      await setMeta(sb, job.id, { live_view_url: null, smoke_error: "browser test could not run" });
      return { url: sandbox.url, works: check.ok, repaired: attempt > 0, untested: true };
    }
    await recordEval({
      name: "smoke_test", score: t.works ? 1 : 0, room: job.room_id, jobId: job.id, pipelineId: job.pipeline_id,
      explanation: `${t.works ? "Works" : "Broken"}${attempt ? " (after repair)" : ""}. Tried: ${t.tried.slice(0, 300)} Saw: ${t.observed.slice(0, 300)}` +
        (t.problems.length ? ` Problems: ${t.problems.join("; ").slice(0, 300)}` : ""),
      task: goal,
    });
    await sb.from("events").insert({
      room_id: job.room_id, author: "huddle", kind: "image", image_url: t.shot || null,
      text: `**Smoke test ${t.works ? "passed" : "failed"}${attempt ? " after repair" : ""}** (Anchor, on the Daytona URL)\n\n${t.observed.slice(0, 500)}`,
      meta: { job_id: job.id, smoke: true },
    });
    await setMeta(sb, job.id, { live_view_url: null, screenshot_url: t.shot || null, smoke: t });
    if ((check.ok && t.works) || attempt >= 1) return { url: sandbox.url, works: check.ok && t.works, repaired: attempt > 0 };

    // Self-repair: give the model what Node and the browser saw, then redeploy into the same sandbox.
    const { text } = await gemini({
      systemInstruction: { parts: [{ text: PROTOTYPE_SYSTEM }] },
      contents: [{ role: "user", parts: [{ text:
        `This prototype was deployed and tested, and it is broken. Fix it; keep everything that works.\n` +
        (check.ok ? "" : `NODE --check OUTPUT:\n${check.log}\n`) +
        `BROWSER TEST: tried: ${t.tried}\nsaw: ${t.observed}\nproblems: ${t.problems.join("; ")}\n\n` +
        `CURRENT HTML:\n\`\`\`html\n${html}\n\`\`\`` }] }],
    }, SMART_MODEL);
    const fixed = extractHtml(text);
    if (!fixed) return { url: sandbox.url, works: false, repaired: false };
    html = fixed;
    await upload(sandbox, "index.html", html);
    await sb.from("jobs").update({ output_html: html, output_md: `${summary}\n\nRepaired after the smoke test.`.trim(), updated_at: now() }).eq("id", proto.id);
    await sb.from("events").insert({
      room_id: job.room_id, author: "huddle", kind: "system",
      text: `Repairing the prototype from what the browser saw, then testing again.`, meta: { job_id: job.id },
    });
  }
}

/** Publish an app with a backend: secrets go in as .env inside the sandbox, then check, smoke-test, repair. */
async function hostAppOnDaytona(sb: SupabaseClient, job: any, proto: any, goal: string, plan?: Plan) {
  let files: Record<string, string> = { ...proto.files };
  const summary: string = proto.output_md ?? "";
  const env = await resolveSecrets(sb, job.room_id, (plan?.required_inputs ?? []).map((i) => i.name));
  const app = await deployApp(files, env, { room: String(job.room_id).slice(0, 60), pipeline: String(job.pipeline_id ?? "") });
  await setMeta(sb, job.id, { sandbox_id: app.id, sandbox_url: app.url });
  const MAX_REPAIRS = 2;
  for (let attempt = 0; ; attempt++) {
    const check = await checkApp(app, files);
    await recordEval({
      name: "build_success", score: check.ok ? 1 : 0, room: job.room_id, jobId: job.id, pipelineId: job.pipeline_id, task: goal,
      explanation: check.ok ? `server.js and the UI pass node --check in the Daytona sandbox${attempt ? ` after ${attempt} repair(s)` : ""}.` : `node --check failed: ${check.log.slice(0, 400)}`,
    });
    const t = await smoke(sb, job, app.url, goal, `${summary}\nDone when: ${plan?.done_when ?? ""}`).catch((e) => (console.error("smoke test", e), null));
    if (!t) {
      await setMeta(sb, job.id, { live_view_url: null, smoke_error: "browser test could not run" });
      return { url: app.url, works: check.ok, repaired: attempt > 0, untested: true };
    }
    await recordEval({
      name: "smoke_test", score: t.works ? 1 : 0, room: job.room_id, jobId: job.id, pipelineId: job.pipeline_id, task: goal,
      explanation: `${t.works ? "Works" : "Broken"}${attempt ? ` (after ${attempt} repair(s))` : ""}. Tried: ${t.tried.slice(0, 300)} Saw: ${t.observed.slice(0, 300)}` +
        (t.problems.length ? ` Problems: ${t.problems.join("; ").slice(0, 300)}` : ""),
    });
    await sb.from("events").insert({
      room_id: job.room_id, author: "huddle", kind: "image", image_url: t.shot || null,
      text: `**Smoke test ${t.works ? "passed" : "failed"}${attempt ? ` after ${attempt} repair(s)` : ""}** (Anchor, on the Daytona app)\n\n${t.observed.slice(0, 500)}`,
      meta: { job_id: job.id, smoke: true },
    });
    await setMeta(sb, job.id, { live_view_url: null, screenshot_url: t.shot || null, smoke: t });
    if ((check.ok && t.works) || attempt >= MAX_REPAIRS) return { url: app.url, works: check.ok && t.works, repaired: attempt > 0 };

    // Self-repair from what Node, the server log and the browser saw. Secrets never go to the model.
    const logs = await appLogs(app);
    const { text } = await gemini({
      systemInstruction: { parts: [{ text: APP_SYSTEM }] },
      contents: [{ role: "user", parts: [{ text:
        `This app was deployed and tested, and it is broken. Fix it; keep everything that works. Output every file again.\n` +
        `DONE WHEN: ${plan?.done_when ?? ""}\nSECRETS IN process.env: ${Object.keys(env).join(", ") || "(none)"}\n` +
        (check.ok ? "" : `NODE --check OUTPUT:\n${check.log}\n`) + (logs ? `SERVER LOG (last lines):\n${logs}\n` : "") +
        `BROWSER TEST: tried: ${t.tried}\nsaw: ${t.observed}\nproblems: ${t.problems.join("; ")}\n\nCURRENT FILES:\n${filesBlock(files)}` }] }],
    }, SMART_MODEL);
    const fixed = extractFiles(text);
    if (!fixed["server.js"] && !fixed["public/index.html"]) return { url: app.url, works: false, repaired: false };
    files = { ...files, ...fixed };
    await uploadApp(app, fixed);
    await startApp(app);
    await sb.from("jobs").update({ files, output_html: files["public/index.html"], output_md: `${summary}\n\nRepaired after the smoke test.`.trim(), updated_at: now() }).eq("id", proto.id);
    await sb.from("events").insert({
      room_id: job.room_id, author: "huddle", kind: "system",
      text: `Repairing the app from what the browser and server log showed (attempt ${attempt + 1} of ${MAX_REPAIRS}), then testing again.`, meta: { job_id: job.id },
    });
  }
}

async function run(jobId: number) {
  const sb = db();
  const { data: job } = await sb.from("jobs").select("*").eq("id", jobId).single();
  if (!job) return;
  return await span(`stage.${job.kind}`, "AGENT", { "input.value": `${job.title}\n${job.prompt}`, metadata: { job_id: jobId, kind: job.kind } },
    (s) => runJob(sb, job, s));
}

async function runJob(sb: SupabaseClient, job: any, s: { set: (a: Record<string, unknown>) => void }) {
  const jobId = job.id;
  const tr = current();
  await sb.from("jobs").update({
    status: "running", error: null, updated_at: now(), meta: { ...(job.meta ?? {}), trace_id: tr?.traceId, span_id: tr?.spanId },
  }).eq("id", jobId);

  try {
    const ctx = await contextPack(sb, job);
    let parentBlock = "";
    if (job.parent_id) {
      const { data: parent } = await sb.from("jobs").select("*").eq("id", job.parent_id).single();
      if (parent) {
        parentBlock = job.kind === "prototype" && parent.files
          ? `\n\nPREVIOUS VERSION (revise it, keep what works; output every file again):\n${filesBlock(parent.files)}`
          : job.kind === "prototype"
          ? `\n\nPREVIOUS VERSION (revise it, keep what works):\n\`\`\`html\n${parent.output_html ?? ""}\n\`\`\``
          : `\n\nPREVIOUS VERSION (revise and extend it):\n${parent.output_md ?? ""}`;
        if (!job.pipeline_id) parentBlock += `\n\nORIGINAL TASK: ${parent.prompt}`;
      }
    }
    const userText = `${ctx.text}\n\nTASK: ${job.title}\n${job.prompt}${parentBlock}`;

    const { data: pipe } = job.pipeline_id
      ? await sb.from("pipelines").select("goal, meta").eq("id", job.pipeline_id).maybeSingle() : { data: null };
    const plan: Plan | undefined = pipe?.meta?.plan;

    if (job.kind === "triage") {
      // Operator room: is this a change to Huddle, or something a normal room should do?
      const t = await geminiJson<any>([{ text: `REQUEST: ${pipe?.goal ?? job.prompt}\n\nROOM CONTEXT:\n${ctx.text.slice(0, 4000)}` }],
        TRIAGE_SCHEMA, FAST_MODEL, TRIAGE_SYSTEM);
      t.needs_keys = (Array.isArray(t.needs_keys) ? t.needs_keys : []).filter((k: any) => /^[A-Z][A-Z0-9_]{1,63}$/.test(String(k.name ?? "")));
      const md = t.kind === "change"
        ? `**Change to Huddle:** ${t.title}\n\n${t.spec}${t.needs_keys.length ? `\n\n**Needs server keys:** ${t.needs_keys.map((k: any) => k.name).join(", ")}` : ""}${t.risky ? "\n\nFlagged risky: a person merges it." : ""}`
        : t.reply;
      await sb.from("jobs").update({ status: "done", review: t, output_md: md, updated_at: now() }).eq("id", jobId);
      s.set({ "output.value": JSON.stringify(t) });
    } else if (job.kind === "change") {
      // Operator room: change any part of Huddle. Locate the files, edit them, verify the repo in Daytona (one fix).
      const { token } = await adminToken(sb);
      const tree = await repoTree(token);
      const spec: string = pipe?.meta?.triage?.spec ?? pipe?.goal ?? job.prompt;
      const submitted: string | undefined = pipe?.meta?.submitted;
      let toRead: string[];
      if (submitted) {
        toRead = [...submitted.matchAll(/```edit:([^\s`]+)/g)].map((m) => m[1]);
      } else {
        const loc = await geminiJson<{ read: string[]; why: string }>([{ text:
          `SPEC: ${spec}\n\nREPO FILES:\n${tree.paths.join("\n")}\n\nList the existing files to read before making this change (max 12).` }],
          LOCATE_SCHEMA, FAST_MODEL, "You know this codebase's layout from its paths. Pick the files a careful engineer would open first.");
        toRead = (loc.read ?? []).filter((p) => tree.paths.includes(p)).slice(0, 12);
      }
      let current = await readFiles(tree.sha, toRead);
      const shown = () => Object.entries(current).map(([p, c]) => `===== ${p} =====\n${c}`).join("\n\n");
      // A revision carries the reviewer's instructions (they're in this job's prompt).
      if (job.parent_id) parentBlock += `\n\nTHE REVIEW OF YOUR LAST ATTEMPT ASKED FOR:\n${job.prompt}`;
      let ask = `SPEC: ${spec}\n${parentBlock}\n\nREPO FILES:\n${tree.paths.join("\n")}\n\nFILES YOU CAN EDIT (full text):\n${shown()}`;
      let result = applyChange(submitted ?? "", current);
      let check = { ok: false, log: "" };
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!(submitted && attempt === 0)) {
          const { text } = await gemini({
            systemInstruction: { parts: [{ text: CHANGE_SYSTEM }] }, contents: [{ role: "user", parts: [{ text: ask }] }],
            generationConfig: { maxOutputTokens: 32000 },
          }, SMART_MODEL);
          result = applyChange(text, current);
        }
        // Edits to files it hadn't read: read them and try again.
        const unread = result.errors.filter((e) => e.includes("not read")).map((e) => e.split(":")[0]).filter((p) => tree.paths.includes(p));
        if (unread.length && attempt < 2) {
          current = { ...current, ...(await readFiles(tree.sha, unread)) };
          ask = `SPEC: ${spec}\n${parentBlock}\n\nREPO FILES:\n${tree.paths.join("\n")}\n\nFILES YOU CAN EDIT (full text):\n${shown()}\n\nYour last answer edited files you hadn't seen; they're included now. Answer again in full.`;
          continue;
        }
        if (!Object.keys(result.files).length && !result.deleted.length) {
          ask += `\n\nYOUR LAST ANSWER CHANGED NOTHING${result.errors.length ? `:\n${result.errors.join("\n")}` : ""}. Answer again in the exact format.`;
          continue;
        }
        check = await verifyChange(result.files, result.deleted);
        if (check.ok && !result.errors.length) break;
        ask += `\n\nYOUR LAST CHANGE FAILED:\n${[...result.errors, check.ok ? "" : check.log].join("\n").slice(-4000)}\nFix it and answer again in full.`;
      }
      if (!check.ok || result.errors.length) throw new Error(`the change doesn't pass checks: ${[...result.errors, check.log].join(" ").slice(-400)}`);
      const sensitive = sensitiveFiles(result.files, result.deleted);
      const list = [...Object.keys(result.files).map((p) => (tree.paths.includes(p) ? `- edit \`${p}\`` : `- new \`${p}\``)), ...result.deleted.map((p) => `- delete \`${p}\``)];
      const md = `**Change to Huddle**\n\n${result.changes.map((c) => `- ${c}`).join("\n") || "- (no summary)"}\n\n**Files**\n${list.join("\n")}\n\n` +
        `**Checks in Daytona:** deno check (server, functions, evals) and node --check (UI) passed.` +
        (result.manual.length ? `\n\n**Manual steps (a person does these):**\n${result.manual.map((m) => `- ${m}`).join("\n")}` : "") +
        (sensitive.length ? `\n\n**Sensitive files** (a person merges): ${sensitive.map((p) => `\`${p}\``).join(", ")}` : "") +
        (result.verify ? `\n\n**How to check it live:** ${result.verify}` : "");
      await sb.from("jobs").update({
        status: "done", files: result.files, output_md: md, updated_at: now(),
        meta: { ...(job.meta ?? {}), base_sha: tree.sha, deleted: result.deleted, changes: result.changes, manual: result.manual, verify: result.verify, sensitive },
      }).eq("id", jobId);
      s.set({ "output.value": md });
    } else if (job.kind === "improve") {
      // Huddle improving Huddle: evidence → smallest prompt change → deno check in Daytona (one fix if it fails).
      const { token } = await adminToken(sb);
      const cur = await currentPrompts(token);
      const ev = await evidence(sb);
      let ask = `OPERATOR REQUEST: ${pipe?.goal ?? job.prompt}\n${parentBlock}\n\nEVIDENCE FROM PRODUCTION:\n${ev}\n\nCURRENT FILE:\n\`\`\`file:${PROMPTS_PATH}\n${cur.content}\n\`\`\``;
      let content = "", text = "", check = { ok: false, log: "" };
      for (let attempt = 0; attempt < 2; attempt++) {
        ({ text } = await gemini({ systemInstruction: { parts: [{ text: IMPROVE_SYSTEM }] }, contents: [{ role: "user", parts: [{ text: ask }] }] }, SMART_MODEL));
        content = extractFiles(text)[PROMPTS_PATH] ?? "";
        if (!content) throw new Error("the change didn't include prompts.ts");
        check = await typeCheck(content);
        if (check.ok) break;
        ask += `\n\nYOUR LAST VERSION FAILED deno check:\n${check.log}\nFix it and output the complete file again.`;
      }
      const changes = [...text.matchAll(/^CHANGE:\s*(.+)$/gim)].map((m) => m[1].trim());
      const expect = text.match(/^EXPECT:\s*(.+)$/im)?.[1]?.trim() ?? "";
      const md = `**Proposed change to \`${PROMPTS_PATH}\`**\n\n${changes.map((c) => `- ${c}`).join("\n") || "- (no summary)"}\n\n` +
        `**Expected effect:** ${expect || "n/a"}\n\n**Type check in Daytona:** ${check.ok ? "passed" : `failed\n\n\`\`\`\n${check.log.slice(-1200)}\n\`\`\``}`;
      if (!check.ok) throw new Error(`the change doesn't type-check: ${check.log.slice(-300)}`);
      await sb.from("jobs").update({ status: "done", files: { [PROMPTS_PATH]: content }, output_md: md, meta: { ...(job.meta ?? {}), base_sha: cur.sha, changes, expect }, updated_at: now() }).eq("id", jobId);
      s.set({ "output.value": md });
    } else if (job.kind === "pr") {
      const { data: change } = await sb.from("jobs").select("id, kind, files, meta, output_md").eq("pipeline_id", job.pipeline_id)
        .in("kind", ["improve", "change"]).eq("status", "done").order("id", { ascending: false }).limit(1).maybeSingle();
      if (!change?.files || !Object.keys(change.files).length && !change.meta?.deleted?.length) throw new Error("no reviewed change to propose");
      const { data: review } = await sb.from("jobs").select("review").eq("pipeline_id", job.pipeline_id).eq("kind", "review").eq("status", "done").order("id", { ascending: false }).limit(1).maybeSingle();
      const { token } = await adminToken(sb);
      const changes: string[] = change.meta?.changes ?? [];
      const title = `Huddle: ${(pipe?.meta?.triage?.title ?? changes[0] ?? pipe?.goal ?? "improve prompts").replace(/[.\s]+$/, "").slice(0, 80)}`;
      const body = `Proposed by Huddle's operator room from production evidence (Arize evals, lessons, failed pipelines).\n\n` +
        `${change.output_md}\n\n**Review:** ${review?.review ? `${review.review.verdict}, ${review.review.score}/10` : "n/a"}\n\n` +
        `The \`evals\` check runs the regression set with this prompt and logs it to Arize as an experiment. Merging deploys it.\n\n` +
        `🤖 Generated with [Claude Code](https://claude.com/claude-code)`;
      const pr = change.kind === "change"
        ? await openPrFiles(token, change.files, change.meta?.deleted ?? [], change.meta?.base_sha, title, body.replace("from production evidence (Arize evals, lessons, failed pipelines)", `on request: ${(pipe?.goal ?? "").slice(0, 300)}`).replace("runs the regression set with this prompt and logs it to Arize as an experiment", "type-checks everything and runs the brief regression set (logged to Arize)"))
        : await openPr(token, change.files[PROMPTS_PATH], change.meta?.base_sha, title, body);
      await sb.from("jobs").update({ status: "done", output_md: `Pull request #${pr.number}: ${pr.url}`, sources: [{ title: `PR #${pr.number}`, url: pr.url }],
        meta: { ...(job.meta ?? {}), pr_number: pr.number, pr_url: pr.url, pr_title: title }, updated_at: now() }).eq("id", jobId);
      s.set({ "output.value": pr.url });
    } else if (job.kind === "ship") {
      // Ship it: CI's eval gate decides. In Full auto Huddle merges a green PR (merging deploys); otherwise a human does.
      const { data: prJob } = await sb.from("jobs").select("meta").eq("pipeline_id", job.pipeline_id).eq("kind", "pr").eq("status", "done")
        .order("id", { ascending: false }).limit(1).maybeSingle();
      const n = prJob?.meta?.pr_number;
      if (!n) throw new Error("no pull request to ship");
      const { token } = await adminToken(sb);
      await sb.from("events").insert({ room_id: job.room_id, author: "huddle", kind: "system", text: `Waiting for CI's evals on PR #${n}…`, meta: { job_id: jobId } });
      const c = await waitForChecks(token, n);
      const { data: roomRow } = await sb.from("rooms").select("mode").eq("id", job.room_id).maybeSingle();
      const { data: change } = await sb.from("jobs").select("meta").eq("pipeline_id", job.pipeline_id).in("kind", ["improve", "change"])
        .eq("status", "done").order("id", { ascending: false }).limit(1).maybeSingle();
      const { data: lastReview } = await sb.from("jobs").select("review").eq("pipeline_id", job.pipeline_id).eq("kind", "review")
        .eq("status", "done").order("id", { ascending: false }).limit(1).maybeSingle();
      const score = Number(lastReview?.review?.score ?? 0);
      const sensitive: string[] = change?.meta?.sensitive ?? [];
      const manual: string[] = change?.meta?.manual ?? [];
      const hand = (why: string) => `CI passed on PR #${n}, but ${why}, so a person merges it: ${prJob.meta.pr_url}`;
      let md: string;
      if (c.conclusion !== "success") {
        md = `Not merged: CI ${c.conclusion} on PR #${n}${c.url ? ` (${c.url})` : ""}. The change stays a proposal.`;
      } else if (roomRow?.mode !== "full") {
        md = hand("Huddle merges by itself only in Full auto");
      } else if (score < 7) {
        md = hand(`its final review scored ${score}/10 (Huddle merges only at 7 or more)`);
      } else if (sensitive.length) {
        md = hand(`it touches sensitive files (${sensitive.join(", ")})`);
      } else if (manual.length) {
        md = hand(`it needs manual steps first (${manual.join("; ").slice(0, 300)})`);
      } else {
        const m = await mergePr(token, n, prJob.meta.pr_title ?? `Huddle change`);
        if (!m.merged) {
          md = `CI passed but GitHub wouldn't merge PR #${n}; merge it yourself: ${prJob.meta.pr_url}`;
        } else {
          await sb.from("events").insert({ room_id: job.room_id, author: "huddle", kind: "system", text: `Merged PR #${n} (review ${score}/10, CI passed). Waiting for the deploy…`, meta: { job_id: jobId } });
          const d = await waitForDeploy(token, m.sha);
          const live = await liveCheck();
          if (d.conclusion === "success" && live.ok) {
            md = `Shipped PR #${n}: merged, deployed (${d.url}), and the live site passed its check (${live.note}).`;
          } else {
            const why = d.conclusion !== "success" ? `the deploy run ${d.conclusion}` : `the live site failed its check (${live.note})`;
            const rev = await revertMerge(token, m.sha, why);
            md = rev
              ? `Merged PR #${n}, but ${why}. Huddle reverted it (commit ${rev.slice(0, 7)}); CI redeploys the previous version.`
              : `Merged PR #${n}, but ${why}, and newer commits landed since, so Huddle didn't auto-revert. A person should check now: ${prJob.meta.pr_url}`;
          }
        }
      }
      await sb.from("events").insert({ room_id: job.room_id, author: "huddle", kind: "system", text: md, meta: { job_id: jobId } });
      await sb.from("jobs").update({ status: "done", output_md: md, sources: [{ title: `PR #${n}`, url: prJob.meta.pr_url }], updated_at: now() }).eq("id", jobId);
      s.set({ "output.value": md });
    } else if (job.kind === "plan") {
      const p = await planGoal(pipe?.goal ?? job.prompt, `\nCONTEXT:\n${ctx.text.slice(0, 6000)}`);
      const md = planMarkdown(p);
      await sb.from("jobs").update({ status: "done", review: p, output_md: md, updated_at: now() }).eq("id", jobId);
      s.set({ "output.value": JSON.stringify(p) });
    } else if (job.kind === "research") {
      const { text, raw } = await gemini({
        systemInstruction: { parts: [{ text: RESEARCH_SYSTEM + await lessonsFor("research") }] },
        contents: [{ role: "user", parts: [{ text: userText }] }],
        tools: [{ google_search: {} }],
        generationConfig: { thinkingConfig: { thinkingLevel: "low" } },
      }, SMART_MODEL);
      // A brief that is empty or only echoes the search call is a failure, not a result: retry it.
      if (text.trim().length < 200 || /^\s*\{\s*"query"/.test(text)) throw new Error("research came back empty; retrying");
      const chunks = raw?.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
      const seen = new Set<string>();
      const sources = chunks
        .map((c: any) => c.web)
        .filter((w: any) => w?.uri && !seen.has(w.uri) && seen.add(w.uri))
        .map((w: any) => ({ title: w.title ?? w.uri, url: w.uri }));
      let note = sources.length ? "" : "\n\n> No web sources came back for this brief — treat its facts as unverified.";
      if (sources.length && anchorOn()) {
        const v = await verifyResearch(job, text, sources);
        note += v.note;
        for (const src of sources) if (v.read.includes(src.url)) (src as any).read_by_anchor = true;
      }
      await sb.from("jobs").update({ status: "done", output_md: text + note, sources, updated_at: now() }).eq("id", jobId);
      s.set({ "output.value": text + note });
    } else if (job.kind === "prototype" && plan?.needs_backend) {
      // A real app: server + UI, run on Daytona with the room's secrets as env vars.
      const names = plan.required_inputs.map((i) => i.name);
      const { text } = await gemini({
        systemInstruction: { parts: [{ text: APP_SYSTEM + await lessonsFor("prototype") }] },
        contents: [{ role: "user", parts: [{ text: `${userText}\n\nSECRETS IN process.env: ${names.join(", ") || "(none)"}\nDONE WHEN: ${plan.done_when}` }] }],
      }, SMART_MODEL);
      const files = extractFiles(text);
      if (!files["server.js"] || !files["public/index.html"]) throw new Error("the app builder didn't return server.js and public/index.html");
      const summary = text.match(/SUMMARY:\s*(.+)/i)?.[1]?.trim() ?? "";
      await sb.from("jobs").update({ status: "done", files, output_html: files["public/index.html"], output_md: summary, updated_at: now() }).eq("id", jobId);
      s.set({ "output.value": `${Object.keys(files).join(", ")}\n${summary}` });
    } else if (job.kind === "prototype") {
      const { text } = await gemini({
        systemInstruction: { parts: [{ text: PROTOTYPE_SYSTEM + await lessonsFor("prototype") }] },
        contents: [{ role: "user", parts: [{ text: userText }] }],
        generationConfig: { thinkingConfig: { thinkingLevel: Deno.env.get("PROTOTYPE_THINKING") ?? "low" } },
      }, SMART_MODEL);
      const html = extractHtml(text);
      if (!html) throw new Error("model returned no HTML");
      const summary = text.match(/SUMMARY:\s*(.+)/i)?.[1]?.trim() ?? "";
      await sb.from("jobs").update({ status: "done", output_html: html, output_md: summary, updated_at: now() }).eq("id", jobId);
    } else if (job.kind === "review") {
      const target = ctx.previous;
      if (!target) throw new Error("nothing to review");
      const work = target.kind === "prototype" && target.files
        ? `APP UNDER REVIEW (all files):\n${filesBlock(target.files).slice(0, 80000)}`
        : target.kind === "prototype"
        ? `PROTOTYPE UNDER REVIEW (HTML):\n\`\`\`html\n${(target.output_html ?? "").slice(0, 60000)}\n\`\`\``
        : `RESEARCH UNDER REVIEW:\n${target.output_md ?? ""}\nSOURCES: ${(target.sources ?? []).length}`;
      const r = await geminiJson<any>(
        [{ text: `${userText}\n\n${work}` }], REVIEW_SCHEMA, FAST_MODEL, REVIEW_SYSTEM,
        { thinkingConfig: { thinkingLevel: "low" } },
      );
      // Models sometimes return a string where a list belongs, or score out of 100.
      for (const k of ["strengths", "issues"]) r[k] = Array.isArray(r[k]) ? r[k].map(String) : r[k] ? [String(r[k])] : [];
      // Keep the score on the 1-10 scale the UI shows.
      r.score = Math.max(1, Math.min(10, Math.round(r.score > 10 ? r.score / 10 : r.score)));
      const md = `**${r.verdict === "pass" ? "Pass" : "Needs revision"}** · ${r.score}/10\n\n` +
        (r.strengths?.length ? `Strengths:\n${r.strengths.map((x: string) => `- ${x}`).join("\n")}\n\n` : "") +
        (r.issues?.length ? `Issues:\n${r.issues.map((x: string) => `- ${x}`).join("\n")}\n\n` : "") +
        (r.verdict === "revise" ? `Revision asked: ${r.revision_instructions}\n\n` : "") +
        (r.question_for_team ? `Question for the team: ${r.question_for_team}` : "");
      await sb.from("jobs").update({ status: "done", review: r, output_md: md, updated_at: now() }).eq("id", jobId);
      s.set({ "output.value": md });
      await recordEval({
        name: "review_score", score: r.score / 10, room: job.room_id, jobId, pipelineId: job.pipeline_id ?? undefined,
        stage: target.kind, task: job.prompt,
        explanation: `${r.verdict}: ${(r.issues ?? []).join("; ") || (r.strengths ?? []).join("; ")}`.slice(0, 900),
      });
    } else if (job.kind === "host") {
      const { data: proto } = await sb.from("jobs").select("id, output_html, output_md, files")
        .eq("pipeline_id", job.pipeline_id).eq("kind", "prototype").eq("status", "done")
        .order("id", { ascending: false }).limit(1).maybeSingle();
      if (!proto?.output_html) throw new Error("no prototype to host");
      // Default: a public share page on the Huddle site itself (no new infra, no protection changes).
      // HOST_MODE=vercel deploys each prototype as its own Vercel project instead — note that new
      // Vercel projects may have Deployment Protection on, which you would turn off yourself.
      const site = (Deno.env.get("PUBLIC_SITE_URL") ?? "").replace(/\/$/, "");
      let url: string;
      let note = "";
      const mode = Deno.env.get("HOST_MODE") ?? (daytonaOn() ? "daytona" : "");
      if (mode === "daytona") {
        const d = proto.files
          ? await hostAppOnDaytona(sb, job, proto, pipe?.goal ?? job.prompt, plan)
          : await hostOnDaytona(sb, job, proto, pipe?.goal ?? job.prompt);
        url = d.url;
        note = (d as { untested?: boolean }).untested ? " (browser test could not run)"
          : d.works ? (d.repaired ? " (repaired once, smoke test passed)" : " (smoke test passed)") : " (smoke test still failing)";
      } else if (mode === "vercel" || !site) {
        const slug = (job.room_id as string).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30);
        url = await deployToVercel(proto.output_html, `huddle-${slug}-p${job.pipeline_id}`);
      } else {
        url = `${site}/p.html?id=${proto.id}`;
      }
      await sb.from("jobs").update({
        status: "done", output_md: `Live at ${url}${note}`, sources: [{ title: "Live prototype", url }], updated_at: now(),
      }).eq("id", jobId);
    } else {
      throw new Error(`unknown job kind ${job.kind}`);
    }

    if (!job.pipeline_id) {
      await sb.from("events").insert({
        room_id: job.room_id, author: "huddle", kind: "system",
        text: `Finished ${job.kind}: ${job.title}`, meta: { job_id: jobId },
      });
    }
  } catch (e) {
    console.error(e);
    await sb.from("jobs").update({ status: "failed", error: String((e as Error)?.message ?? e), updated_at: now() }).eq("id", jobId);
  }
  if (job.pipeline_id) await invokeFn("orchestrate", { pipeline_id: job.pipeline_id });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { job_id } = await req.json();
    if (!job_id) return json({ error: "job_id required" }, 400);
    background(run(Number(job_id)));
    return json({ started: job_id });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
