// POST { room, force? } -> folds new events into the room's living brief, starts agent pipelines for
// actionable next steps, and turns spoken answers into decisions on pipelines waiting at a gate.
import { cors, db, geminiJson, json, SMART_MODEL } from "../_shared/util.ts";
import { createPipeline, invokeFn } from "../_shared/pipeline.ts";

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
    new_pipelines: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          kind: { type: "STRING", enum: ["research", "build", "prototype"] },
          title: { type: "STRING" },
          goal: { type: "STRING" },
        },
        required: ["kind", "title", "goal"],
      },
    },
    obsolete_pipeline_ids: { type: "ARRAY", items: { type: "INTEGER" } },
    gate_answers: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          pipeline_id: { type: "INTEGER" },
          decision: { type: "STRING", enum: ["approve", "skip", "stop"] },
          answer: { type: "STRING" },
        },
        required: ["pipeline_id", "decision", "answer"],
      },
    },
  },
  required: ["goal", "summary", "changed", "decisions", "questions", "ideas", "next_steps", "new_pipelines", "obsolete_pipeline_ids", "gate_answers"],
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
- new_pipelines: agent work to START NOW for research/prototype next steps the team clearly wants,
  that no existing pipeline (listed below) already covers. kind: "research" (find out only), "build"
  (research then make it, review, publish), "prototype" (make it now). goal = a self-contained
  instruction with every specific from the conversation. At most 2 per update; none while the team
  is still exploring or undecided.
- obsolete_pipeline_ids: ids of pipelines still "proposed" that the latest decisions made unnecessary.
- gate_answers: for pipelines WAITING on a question, if a new event answers it (e.g. "yes publish it",
  "target hackathon teams", "stop that one"), return pipeline_id, decision (approve | skip | stop) and
  the answer in the speaker's words. Only when the answer is clear.
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

    const { data: pipes } = await sb
      .from("pipelines")
      .select("id, title, status, stages, current, gate")
      .eq("room_id", room)
      .not("status", "in", "(stopped)")
      .order("id", { ascending: false })
      .limit(30);
    const evText = (events ?? [])
      .map((e) => `[#${e.id} ${e.author} ${e.kind}] ${(e.text ?? "").slice(0, 2000)}`)
      .join("\n");
    const pipeText = (pipes ?? []).map((p) =>
      `- #${p.id} ${p.title} [${p.status}, at ${p.stages[p.current]}]` +
      (p.status === "waiting" && p.gate ? ` WAITING ON: ${p.gate.question}` : "")
    ).join("\n") || "(none)";

    const next = await geminiJson<any>(
      [{
        text:
          `CURRENT BRIEF (JSON):\n${JSON.stringify(brain.state ?? {})}\n\n` +
          `AGENT PIPELINES:\n${pipeText}\n\nNEW EVENTS:\n${evText || "(none)"}\n\nReturn the updated brief.`,
      }],
      SCHEMA,
      SMART_MODEL,
      SYSTEM,
      { thinkingConfig: { thinkingLevel: Deno.env.get("SYNTH_THINKING") ?? "low" } },
    );

    const newPipes = (next.new_pipelines ?? []).slice(0, 2);
    const obsolete: number[] = next.obsolete_pipeline_ids ?? [];
    const answers = next.gate_answers ?? [];
    delete next.new_pipelines;
    delete next.obsolete_pipeline_ids;
    delete next.gate_answers;
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

    const waiting = new Set((pipes ?? []).filter((p) => p.status === "waiting").map((p) => p.id));
    for (const a of answers) {
      if (waiting.has(a.pipeline_id)) await invokeFn("orchestrate", { pipeline_id: a.pipeline_id, action: a.decision, answer: a.answer });
    }
    for (const np of newPipes) {
      await createPipeline(sb, { room, title: np.title, goal: np.goal, kind: np.kind, created_by: "huddle" });
    }
    if (obsolete.length) {
      // Only ever drop pipelines nobody has started.
      await sb.from("pipelines").update({ status: "stopped" })
        .eq("room_id", room).eq("status", "proposed").in("id", obsolete);
    }
    return json({ brain: updated, started: newPipes.length, answered: answers.length, dismissed: obsolete.length });
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
