// POST { job_id } -> runs one job (research | review | prototype | host) in the background.
// Status streams back via Realtime; pipeline jobs hand control back to the orchestrator when done.
import { background, cors, db, FAST_MODEL, gemini, geminiJson, json, SMART_MODEL } from "../_shared/util.ts";
import { invokeFn } from "../_shared/pipeline.ts";
import { PROTOTYPE_SYSTEM, RESEARCH_SYSTEM, REVIEW_SCHEMA, REVIEW_SYSTEM } from "../_shared/prompts.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { lessonsFor, recordEval, judgeGrounding } from "../_shared/evals.ts";
import { anchorOn, closeSession, openSession, readPage, screenshot, smokeTest } from "../_shared/anchor.ts";
import { checkScripts, daytonaOn, deploySite, upload, type Sandbox } from "../_shared/daytona.ts";
import { current, span } from "../_shared/trace.ts";

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
    const { data: done } = await sb.from("jobs").select("id, kind, stage_index, output_md, output_html, sources")
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
  const unsupported = (v.unsupported_claims as string[] | undefined) ?? [];
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
        parentBlock = job.kind === "prototype"
          ? `\n\nPREVIOUS VERSION (revise it, keep what works):\n\`\`\`html\n${parent.output_html ?? ""}\n\`\`\``
          : `\n\nPREVIOUS VERSION (revise and extend it):\n${parent.output_md ?? ""}`;
        if (!job.pipeline_id) parentBlock += `\n\nORIGINAL TASK: ${parent.prompt}`;
      }
    }
    const userText = `${ctx.text}\n\nTASK: ${job.title}\n${job.prompt}${parentBlock}`;

    if (job.kind === "research") {
      const { text, raw } = await gemini({
        systemInstruction: { parts: [{ text: RESEARCH_SYSTEM + await lessonsFor("research") }] },
        contents: [{ role: "user", parts: [{ text: userText }] }],
        tools: [{ google_search: {} }],
        generationConfig: { thinkingConfig: { thinkingLevel: "low" } },
      }, SMART_MODEL);
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
      const work = target.kind === "prototype"
        ? `PROTOTYPE UNDER REVIEW (HTML):\n\`\`\`html\n${(target.output_html ?? "").slice(0, 60000)}\n\`\`\``
        : `RESEARCH UNDER REVIEW:\n${target.output_md ?? ""}\nSOURCES: ${(target.sources ?? []).length}`;
      const r = await geminiJson<any>(
        [{ text: `${userText}\n\n${work}` }], REVIEW_SCHEMA, FAST_MODEL, REVIEW_SYSTEM,
        { thinkingConfig: { thinkingLevel: "low" } },
      );
      // Models sometimes score out of 100; keep it on the 1-10 scale the UI shows.
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
      const { data: proto } = await sb.from("jobs").select("id, output_html, output_md")
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
        const { data: pipe } = await sb.from("pipelines").select("goal").eq("id", job.pipeline_id).maybeSingle();
        const d = await hostOnDaytona(sb, job, proto, pipe?.goal ?? job.prompt);
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
