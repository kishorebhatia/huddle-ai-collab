// POST { room, force? } -> folds new events into the room's living brief, starts agent pipelines for
// actionable next steps, and turns spoken answers into decisions on pipelines waiting at a gate.
import { background, cors, db, geminiJson, json, SMART_MODEL } from "../_shared/util.ts";
import { judgeBrief, lessonsFor, recordEval } from "../_shared/evals.ts";
import { createPipeline, invokeFn } from "../_shared/pipeline.ts";
import { SYNTH_SCHEMA, SYNTH_SYSTEM } from "../_shared/prompts.ts";

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
      .select("id, author, kind, text, image_url, meta, created_at")
      .eq("room_id", room)
      .gt("id", brain.last_event_id)
      .eq("forgotten", false)
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
    // Huddle's own "Learned…" notes are about Huddle, not the team: leave them out of the brief.
    const evText = (events ?? []).filter((e) => !e.meta?.lesson)
      .map((e) => `[#${e.id} ${e.author} ${e.kind}] ${(e.text ?? "").slice(0, 2000)}`)
      .join("\n");
    const pipeText = (pipes ?? []).map((p) =>
      `- #${p.id} ${p.title} [${p.status}, at ${p.stages[p.current]}]` +
      (p.status === "waiting" && p.gate ? ` WAITING ON: ${p.gate.question}` : "")
    ).join("\n") || "(none)";

    // Decisions the team locked stay word for word, whatever the model returns.
    const locked: { text: string; by?: string; refs?: number[] }[] = Array.isArray(brain.locked) ? brain.locked : [];
    const lockedText = locked.length ? locked.map((l) => `- ${l.text}`).join("\n") : "(none)";

    const next = await geminiJson<any>(
      [{
        text:
          `CURRENT BRIEF (JSON):\n${JSON.stringify(brain.state ?? {})}\n\n` +
          `LOCKED DECISIONS (the team locked these; keep each one in decisions exactly as written):\n${lockedText}\n\n` +
          `AGENT PIPELINES:\n${pipeText}\n\nNEW EVENTS:\n${evText || "(none)"}\n\nReturn the updated brief.`,
      }],
      SYNTH_SCHEMA,
      SMART_MODEL,
      SYNTH_SYSTEM + await lessonsFor("synthesize"),
      { thinkingConfig: { thinkingLevel: Deno.env.get("SYNTH_THINKING") ?? "low" } },
    );

    const newPipes = (next.new_pipelines ?? []).slice(0, 2);
    const obsolete: number[] = next.obsolete_pipeline_ids ?? [];
    const answers = next.gate_answers ?? [];
    delete next.new_pipelines;
    delete next.obsolete_pipeline_ids;
    delete next.gate_answers;
    const decisions = Array.isArray(next.decisions) ? next.decisions : [];
    for (const l of [...locked].reverse()) {
      const i = decisions.findIndex((d: any) => d?.text === l.text);
      if (i >= 0) decisions.splice(i, 1);
      decisions.unshift({ text: l.text, by: l.by, refs: l.refs ?? [] });
    }
    next.decisions = decisions;
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
    // Online eval: is the new brief faithful to what was said? (Arize annotation + lesson if low.)
    // Only judge updates driven by what people said, not by Huddle's own system notes.
    const said = (events ?? []).filter((e) => e.kind !== "system")
      .map((e) => `[#${e.id} ${e.author} ${e.kind}] ${(e.text ?? "").slice(0, 2000)}`).join("\n");
    if (said) {
      background(judgeBrief(said, next).then((v) => recordEval({
        name: "faithfulness", score: v.score, room, stage: "synthesize",
        explanation: `${v.explanation}${(v.unsupported as string[] | undefined)?.length ? ` Unsupported: ${(v.unsupported as string[]).join("; ")}` : ""}`.slice(0, 900),
      })).catch((e) => console.error("faithfulness eval", e)));
    }

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
