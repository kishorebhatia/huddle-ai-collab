// The pipeline state machine. Called when a pipeline starts, when a stage job finishes,
// when someone acts on a gate (approve / skip / answer / stop / start), and by a 1-minute cron sweep.
//
// POST { pipeline_id }                              -> advance it if its current stage is finished
// POST { pipeline_id, action, answer? }             -> start | approve | skip | answer | stop
// POST { room, action: "stop_all" | "resume" }      -> kill switch for a room
// POST { sweep: true }                              -> unstick stalled pipelines and jobs
import { cors, db, json } from "../_shared/util.ts";
import { getRoom, invokeFn, postEvent, stagesFor, type Room } from "../_shared/pipeline.ts";
import { planGoal, type Plan } from "../_shared/plan.ts";
import { secretNames } from "../_shared/vault.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

type Job = {
  id: number; stage_index: number; status: string; kind: string; review: any;
  output_md: string | null; error: string | null; updated_at: string;
};

const MAX_REVISIONS = 1;   // per reviewed stage
const MAX_RETRIES = 1;     // per failed stage
const STUCK_MS = 6 * 60_000;

async function load(sb: SupabaseClient, pid: number) {
  const { data: p } = await sb.from("pipelines").select("*").eq("id", pid).maybeSingle();
  return p;
}

async function save(sb: SupabaseClient, pid: number, patch: Record<string, unknown>) {
  await sb.from("pipelines").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", pid);
}

async function startStage(sb: SupabaseClient, p: any, s: number, room: Room, opts: { parentId?: number; instructions?: string } = {}) {
  // Budget check: too many jobs this hour → ask the room before spending more
  const overrideUntil = p.meta?.budget_override_until ? Date.parse(p.meta.budget_override_until) : 0;
  if (Date.now() > overrideUntil) {
    const since = new Date(Date.now() - 3600_000).toISOString();
    const { count } = await sb.from("jobs").select("id", { count: "exact", head: true })
      .eq("room_id", p.room_id).gte("created_at", since);
    if ((count ?? 0) >= room.max_jobs_per_hour) {
      const question = `Budget: ${count} agent jobs ran in the last hour (limit ${room.max_jobs_per_hour}). Continue "${p.title}"?`;
      await save(sb, p.id, { status: "waiting", gate: { kind: "budget", question, stage: s } });
      await postEvent(sb, p.room_id, `Needs a decision — ${question}`, { pipeline_id: p.id });
      return;
    }
  }
  const stage = p.stages[s];
  const answers = (p.meta?.answers ?? []).map((a: any) => `- Q: ${a.q}\n  A: ${a.a}`).join("\n");
  const STAGE_ONLY: Record<string, string> = {
    plan: "Plan how to deliver the goal end to end. Do not do the work yet.",
    improve: "Change Huddle's prompts to fix what the evidence shows. Only prompts.ts.",
    pr: "Open a pull request with the reviewed change.",
    research: "Do ONLY the research. Do not write code, HTML or page copy — a later stage builds it.",
    review: "Review ONLY the output of the stage just before this one.",
    prototype: p.meta?.plan?.needs_backend
      ? `Build the app (server + UI), grounded in the research and the conversation. Done when: ${p.meta.plan.done_when}. ` +
        `Secrets it reads from process.env: ${(p.meta.plan.required_inputs ?? []).map((i: any) => i.name).join(", ") || "none"}.`
      : "Build the prototype, grounded in the research and the conversation.",
    host: "Publish the latest prototype.",
  };
  const prompt = `STAGE ${s + 1} of ${p.stages.length} (${p.stages.join(" → ")}): ${stage.toUpperCase()}. ${STAGE_ONLY[stage] ?? ""}\n\n` +
    (opts.instructions ? `REVISE the previous version using this review:\n${opts.instructions}\n\n` : "") +
    `PIPELINE GOAL: ${p.goal}` + (answers ? `\n\nTEAM ANSWERS SO FAR:\n${answers}` : "");
  const { data: job, error } = await sb.from("jobs").insert({
    room_id: p.room_id, pipeline_id: p.id, stage_index: s, kind: stage,
    title: `${p.title} · ${stage}${opts.instructions ? " (revision)" : ""}`,
    prompt, parent_id: opts.parentId ?? null, created_by: "huddle", status: "proposed",
  }).select().single();
  if (error) {
    // unique index hit = another orchestrator call already started this stage
    if (!String(error.message).includes("jobs_one_active_stage")) console.error(error);
    return;
  }
  await save(sb, p.id, { current: s });
  await invokeFn("run-job", { job_id: job.id });
}

async function advance(sb: SupabaseClient, p: any, s: number, room: Room) {
  const next = s + 1;
  if (next >= p.stages.length) {
    await save(sb, p.id, { status: "done", gate: null, current: s });
    await postEvent(
      sb, p.room_id,
      `Done: ${p.title}${p.host_url ? ` — live at ${p.host_url}` : ""}`,
      { pipeline_id: p.id },
    );
    // Every finished pipeline is saved to the room's GitHub repository (created on the first one).
    invokeFn("github", { room: p.room_id, action: "publish", auto: true }).catch((e) => console.warn("auto publish", e));
    return;
  }
  // A build that needs keys waits for the room to supply them (in every mode: nobody can guess a key).
  const inputs = (p.meta?.plan?.required_inputs ?? []) as Plan["required_inputs"];
  if (p.stages[next] === "prototype" && inputs.length) {
    const { missing } = await secretNames(sb, p.room_id, inputs.map((i) => i.name));
    if (missing.length) {
      const need = inputs.filter((i) => missing.includes(i.name));
      const question = `This build needs ${need.map((i) => i.label).join(" and ")}. Add ${need.length > 1 ? "them" : "it"} below: ` +
        `${need.length > 1 ? "they're" : "it's"} stored encrypted, used only by the build's sandbox, and never shown in the room.`;
      await save(sb, p.id, { status: "waiting", current: s, gate: { kind: "secret", question, stage: next, inputs: need } });
      await postEvent(sb, p.room_id, `Needs a key: "${p.title}" needs ${need.map((i) => i.label).join(", ")}. Add it in Agent work.`, { pipeline_id: p.id });
      return;
    }
  }
  if (p.stages[next] === "host" && room.mode !== "full" && !p.meta?.approved_publish) {
    const question = `Publish "${p.title}" to a public URL?`;
    await save(sb, p.id, { status: "waiting", current: s, gate: { kind: "publish", question, stage: next } });
    await postEvent(sb, p.room_id, `Needs a decision — ${question} (say "yes, publish it" or use the button)`, { pipeline_id: p.id });
    return;
  }
  await save(sb, p.id, { current: next });
  await startStage(sb, { ...p, current: next }, next, room);
}

async function step(sb: SupabaseClient, pid: number) {
  const p = await load(sb, pid);
  if (!p || p.status !== "running") return { skipped: p?.status ?? "missing" };
  const room = await getRoom(sb, p.room_id);
  if (room.paused) return { skipped: "paused" };

  const { data: jobs } = await sb.from("jobs")
    .select("id, stage_index, status, kind, review, output_md, error, updated_at")
    .eq("pipeline_id", pid).order("id");
  const all = (jobs ?? []) as Job[];
  const latest = (i: number) => [...all].reverse().find((j) => j.stage_index === i);
  const latestDone = (i: number) => [...all].reverse().find((j) => j.stage_index === i && j.status === "done");

  const s = p.current as number;
  const cur = latest(s);
  const prev = s > 0 ? latestDone(s - 1) : undefined;
  const fresh = cur && (!prev || cur.id > prev.id); // a stage result is only valid if newer than its input

  if (!fresh) { await startStage(sb, p, s, room); return { started: p.stages[s] }; }
  if (cur.status === "proposed" || cur.status === "running") return { waiting: p.stages[s] };

  if (cur.status === "failed") {
    const fails = p.meta?.failures?.[s] ?? 0;
    if (fails < MAX_RETRIES) {
      await save(sb, p.id, { meta: { ...p.meta, failures: { ...(p.meta?.failures ?? {}), [s]: fails + 1 } } });
      await startStage(sb, p, s, room);
      return { retried: p.stages[s] };
    }
    await save(sb, p.id, { status: "failed" });
    await postEvent(sb, p.room_id, `Failed: ${p.title} at ${p.stages[s]} — ${cur.error ?? "unknown error"}`, { pipeline_id: p.id });
    return { failed: p.stages[s] };
  }

  // cur.status === "done"
  if (p.stages[s] === "plan" && cur.review) {
    const plan = cur.review as Plan;
    const stages = stagesFor(plan);
    if (stages.join() !== p.stages.join()) {
      await postEvent(sb, p.room_id, `Plan for "${p.title}": ${stages.slice(1).join(" → ")}`, { pipeline_id: p.id });
    }
    p.stages = stages;
    p.meta = { ...(p.meta ?? {}), plan };
    await save(sb, p.id, { stages, meta: p.meta });
  }
  if (p.stages[s] === "review") {
    const r = cur.review ?? {};
    const asked = p.meta?.asked ?? {};
    if (r.question_for_team && !asked[s] && room.mode === "full") {
      // Full auto: don't stop to ask. Record the assumption so later stages (and the room) see it.
      p.meta = { ...(p.meta ?? {}), asked: { ...asked, [s]: true },
        answers: [...(p.meta?.answers ?? []), { q: r.question_for_team, a: "Not asked (full auto): use your best judgment and state the assumption." }] };
      await save(sb, p.id, { meta: p.meta });
      await postEvent(sb, p.room_id, `Assumed instead of asking (full auto): ${r.question_for_team}`, { pipeline_id: p.id });
    } else if (r.question_for_team && !asked[s]) {
      await save(sb, p.id, {
        status: "waiting",
        gate: { kind: "question", question: r.question_for_team, stage: s },
        meta: { ...p.meta, asked: { ...asked, [s]: true } },
      });
      await postEvent(sb, p.room_id, `Question from the agent on "${p.title}": ${r.question_for_team}`, { pipeline_id: p.id });
      return { gated: "question" };
    }
    const revs = p.meta?.revisions?.[s - 1] ?? 0;
    if (r.verdict === "revise" && revs < MAX_REVISIONS) {
      const target = latestDone(s - 1);
      await save(sb, p.id, {
        current: s - 1,
        meta: { ...p.meta, revisions: { ...(p.meta?.revisions ?? {}), [s - 1]: revs + 1 } },
      });
      await postEvent(sb, p.room_id, `Review sent "${p.title}" back for one revision (score ${r.score ?? "?"}/10).`, { pipeline_id: p.id });
      await startStage(sb, { ...p, current: s - 1 }, s - 1, room, {
        parentId: target?.id, instructions: r.revision_instructions || (r.issues ?? []).join("\n"),
      });
      return { revising: p.stages[s - 1] };
    }
  }
  if ((p.stages[s] === "host" || p.stages[s] === "pr") && cur.output_md) {
    p.host_url = cur.output_md.match(/https?:\/\/\S+/)?.[0] ?? null;
    await save(sb, p.id, { host_url: p.host_url });
  }
  await advance(sb, p, s, room);
  return { advanced_from: p.stages[s] };
}

async function act(sb: SupabaseClient, pid: number, action: string, answer?: string) {
  const p = await load(sb, pid);
  if (!p) return { error: "no such pipeline" };
  const meta = { ...(p.meta ?? {}) };
  if (action === "stop") {
    await save(sb, pid, { status: "stopped", gate: null });
    await sb.from("jobs").update({ status: "dismissed" }).eq("pipeline_id", pid).eq("status", "proposed");
    await postEvent(sb, p.room_id, `Stopped: ${p.title}`, { pipeline_id: pid });
    return { stopped: pid };
  }
  if (action === "start" && (p.status === "proposed" || p.status === "stopped" || p.status === "failed")) {
    await save(sb, pid, { status: "running", meta: { ...meta, failures: {} } });
    return await step(sb, pid);
  }
  if (p.status !== "waiting" || !p.gate) return { ignored: `pipeline is ${p.status}` };
  const gate = p.gate;
  if (gate.kind === "publish") {
    if (action === "skip") {
      await save(sb, pid, { status: "done", gate: null });
      await postEvent(sb, p.room_id, `Done without publishing: ${p.title}`, { pipeline_id: pid });
      return { done: pid };
    }
    meta.approved_publish = true;
  }
  if (gate.kind === "budget") meta.budget_override_until = new Date(Date.now() + 3600_000).toISOString();
  if (gate.kind === "secret") {
    if (action === "skip") {
      await save(sb, pid, { status: "stopped", gate: null });
      await postEvent(sb, p.room_id, `Stopped "${p.title}": it can't be built without ${(gate.inputs ?? []).map((i: any) => i.label).join(", ")}.`, { pipeline_id: pid });
      return { stopped: pid };
    }
    const { missing } = await secretNames(sb, p.room_id, (gate.inputs ?? []).map((i: any) => i.name));
    if (missing.length) return { missing };
  }
  if (gate.kind === "question") {
    meta.answers = [...(meta.answers ?? []), { q: gate.question, a: answer || (action === "skip" ? "Use your best judgment." : "Approved as proposed.") }];
  }
  // An answer can widen the goal ("include the prototype buildout"): plan again and add build stages.
  let stages = p.stages as string[];
  if (gate.kind === "question" && answer && !stages.includes("prototype")) {
    const plan = await planGoal(p.goal, `TEAM ANSWERS:\n${meta.answers.map((a: any) => `- ${a.q} → ${a.a}`).join("\n")}`).catch(() => null);
    if (plan?.deliverable === "app") {
      stages = [...stages, "prototype", "review", "host"];
      meta.plan = plan;
      await postEvent(sb, p.room_id, `"${p.title}" will now also be built: ${stages.join(" → ")}`, { pipeline_id: pid });
    }
  }
  await save(sb, pid, { status: "running", gate: null, meta, stages });
  if (answer) await postEvent(sb, p.room_id, `Got it — continuing "${p.title}" with: ${answer}`, { pipeline_id: pid });
  return await step(sb, pid);
}

async function sweep(sb: SupabaseClient) {
  // Jobs that died mid-run (function killed) → failed, so the pipeline can retry
  const stuckBefore = new Date(Date.now() - STUCK_MS).toISOString();
  await sb.from("jobs").update({ status: "failed", error: "timed out" })
    .eq("status", "running").lt("updated_at", stuckBefore);
  // Pipelines with no movement for 45 s get a nudge
  const idleBefore = new Date(Date.now() - 45_000).toISOString();
  const { data: ps } = await sb.from("pipelines").select("id").eq("status", "running").lt("updated_at", idleBefore).limit(20);
  const out = [];
  for (const p of ps ?? []) out.push({ id: p.id, ...(await step(sb, p.id)) });
  return { swept: out };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const sb = db();
    if (body.sweep) return json(await sweep(sb));
    if (body.room && (body.action === "stop_all" || body.action === "resume")) {
      const paused = body.action === "stop_all";
      await getRoom(sb, body.room);
      await sb.from("rooms").update({ paused }).eq("id", body.room);
      if (paused) {
        await sb.from("pipelines").update({ status: "stopped", gate: null }).eq("room_id", body.room).in("status", ["running", "waiting"]);
        await sb.from("jobs").update({ status: "dismissed" }).eq("room_id", body.room).eq("status", "proposed");
        await postEvent(sb, body.room, "Stop all: agent work paused for this room.");
      } else {
        await postEvent(sb, body.room, "Agent work resumed.");
      }
      return json({ paused });
    }
    if (!body.pipeline_id) return json({ error: "pipeline_id required" }, 400);
    const pid = Number(body.pipeline_id);
    if (body.action) return json(await act(sb, pid, body.action, body.answer));
    return json(await step(sb, pid));
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
