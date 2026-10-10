// The pipeline state machine. Called when a pipeline starts, when a stage job finishes,
// when someone acts on a gate (approve / skip / answer / stop / start), and by a 1-minute cron sweep.
//
// POST { pipeline_id }                              -> advance it if its current stage is finished
// POST { pipeline_id, action, answer? }             -> start | approve | skip | answer | stop
// POST { room, action: "stop_all" | "resume" }      -> kill switch for a room
// POST { sweep: true }                              -> unstick stalled pipelines and jobs
import { cors, db, json } from "../_shared/util.ts";
import { getRoom, invokeFn, postEvent, type Room } from "../_shared/pipeline.ts";
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
    research: "Do ONLY the research. Do not write code, HTML or page copy — a later stage builds it.",
    review: "Review ONLY the output of the stage just before this one.",
    prototype: "Build the prototype, grounded in the research and the conversation.",
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
    return;
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
  if (p.stages[s] === "review") {
    const r = cur.review ?? {};
    const asked = p.meta?.asked ?? {};
    if (r.question_for_team && !asked[s]) {
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
  if (p.stages[s] === "host" && cur.output_md) {
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
  if (gate.kind === "question") {
    meta.answers = [...(meta.answers ?? []), { q: gate.question, a: answer || (action === "skip" ? "Use your best judgment." : "Approved as proposed.") }];
  }
  await save(sb, pid, { status: "running", gate: null, meta });
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
