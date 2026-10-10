// POST { room, force? } -> folds new events into the room's living brief and proposes agent jobs
import { cors, db, geminiJson, json, SMART_MODEL } from "../_shared/util.ts";

const item = (extra: Record<string, unknown> = {}) => ({
  type: "OBJECT",
  properties: {
    text: { type: "STRING" },
    by: { type: "STRING" },
    refs: { type: "ARRAY", items: { type: "INTEGER" } },
    ...extra,
  },
  required: ["text"],
});

const SCHEMA = {
  type: "OBJECT",
  properties: {
    goal: { type: "STRING" },
    summary: { type: "STRING" },
    changed: { type: "ARRAY", items: { type: "STRING" } },
    decisions: { type: "ARRAY", items: item() },
    questions: { type: "ARRAY", items: item() },
    ideas: { type: "ARRAY", items: item() },
    next_steps: {
      type: "ARRAY",
      items: item({
        owner: { type: "STRING" },
        type: { type: "STRING", enum: ["research", "prototype", "decide", "ask"] },
      }),
    },
    new_jobs: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          kind: { type: "STRING", enum: ["research", "prototype"] },
          title: { type: "STRING" },
          prompt: { type: "STRING" },
        },
        required: ["kind", "title", "prompt"],
      },
    },
    obsolete_job_ids: { type: "ARRAY", items: { type: "INTEGER" } },
  },
  required: ["goal", "summary", "changed", "decisions", "questions", "ideas", "next_steps", "new_jobs", "obsolete_job_ids"],
};

const SYSTEM = `You are the shared brain of a small team working together live (often at a hackathon).
You maintain ONE living brief of the session. You receive the current brief plus new events
(speech transcripts, typed notes, links, whiteboard/sketch readings, findings posted by teammates'
own AI assistants, and feedback on outputs). Each event is tagged [#id author kind].

Rules:
- EDIT the brief, don't append history. Merge duplicates, drop items that were resolved or reversed,
  promote a question to a decision when the team settles it. Keep each list short (max ~8 items).
- Every item carries refs: the event ids it came from. "by" = who said or owns it, when clear.
- goal: one sentence on what the team is trying to achieve right now.
- summary: 2-4 sentences on where things stand.
- changed: 1-4 short bullets on what changed since the previous brief (empty if nothing material).
- next_steps: concrete actions with an owner when someone volunteered; type research | prototype | decide | ask.
- new_jobs: ONLY for research or prototype next steps that an AI agent could do right now AND that are
  not already covered by an existing job (listed below). Write a self-contained prompt with all the
  context the agent needs. Propose at most 2 per update; propose none if the team is still exploring.
- obsolete_job_ids: ids of jobs still "proposed" that the team's latest decisions made unnecessary
  (e.g. research on a question that is now settled). Never list running or done jobs.
- Never invent facts or decisions nobody stated.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { room, force } = await req.json();
    if (!room) return json({ error: "room required" }, 400);
    const sb = db();

    let { data: brain } = await sb.from("brain").select("*").eq("room_id", room).maybeSingle();
    if (!brain) {
      const ins = await sb.from("brain").insert({ room_id: room }).select().single();
      brain = ins.data;
    }

    const { data: events } = await sb
      .from("events")
      .select("id, author, kind, text, image_url, created_at")
      .eq("room_id", room)
      .gt("id", brain.last_event_id)
      .order("id", { ascending: true })
      .limit(300);

    if (!events?.length && !force) return json({ unchanged: true, brain });

    const { data: jobs } = await sb
      .from("jobs")
      .select("id, kind, title, status")
      .eq("room_id", room)
      .neq("status", "dismissed")
      .order("id", { ascending: false })
      .limit(40);

    const evText = (events ?? [])
      .map((e) => `[#${e.id} ${e.author} ${e.kind}] ${(e.text ?? "").slice(0, 2000)}`)
      .join("\n");
    const jobText = (jobs ?? []).map((j) => `- #${j.id} ${j.kind} (${j.status}): ${j.title}`).join("\n") || "(none)";

    const next = await geminiJson<any>(
      [{
        text:
          `CURRENT BRIEF (JSON):\n${JSON.stringify(brain.state ?? {})}\n\n` +
          `EXISTING JOBS:\n${jobText}\n\nNEW EVENTS:\n${evText || "(none)"}\n\nReturn the updated brief.`,
      }],
      SCHEMA,
      SMART_MODEL,
      SYSTEM,
      { thinkingConfig: { thinkingLevel: Deno.env.get("SYNTH_THINKING") ?? "low" } },
    );

    const newJobs = (next.new_jobs ?? []).slice(0, 2);
    const obsolete: number[] = next.obsolete_job_ids ?? [];
    delete next.new_jobs;
    delete next.obsolete_job_ids;
    const lastId = events?.length ? events[events.length - 1].id : brain.last_event_id;

    // Optimistic concurrency: only one synthesis wins per version.
    const { data: updated } = await sb
      .from("brain")
      .update({ state: next, version: brain.version + 1, last_event_id: lastId, updated_at: new Date().toISOString() })
      .eq("room_id", room)
      .eq("version", brain.version)
      .select()
      .maybeSingle();
    if (!updated) return json({ conflict: true });

    if (newJobs.length) {
      await sb.from("jobs").insert(
        newJobs.map((j: any) => ({ room_id: room, kind: j.kind, title: j.title, prompt: j.prompt, created_by: "huddle" })),
      );
    }
    if (obsolete.length) {
      // Only ever dismiss jobs nobody has started.
      await sb.from("jobs").update({ status: "dismissed" })
        .eq("room_id", room).eq("status", "proposed").in("id", obsolete);
    }
    return json({ brain: updated, proposed: newJobs.length, dismissed: obsolete.length });
  } catch (e) {
    console.error(e);
    return json({ error: String(e?.message ?? e) }, 500);
  }
});
