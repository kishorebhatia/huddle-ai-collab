// POST { room, author, text, event_id } -> if the line is a request for agent work, start a pipeline now.
// Called by transcribe (spoken) and by the browser (typed notes), so requests don't wait for the next brief.
import { cors, db, geminiJson, json } from "../_shared/util.ts";
import { createPipeline } from "../_shared/pipeline.ts";

const INTENT_MODEL = Deno.env.get("INTENT_MODEL") ?? "gemini-3.5-flash-lite";

const SCHEMA = {
  type: "OBJECT",
  properties: {
    is_request: { type: "BOOLEAN" },
    kind: { type: "STRING", enum: ["research", "build", "prototype"] },
    title: { type: "STRING" },
    goal: { type: "STRING" },
    duplicate_of: { type: "INTEGER" },
  },
  required: ["is_request", "kind", "title", "goal", "duplicate_of"],
};

const SYSTEM = `You watch a live team conversation for requests aimed at the team's AI agent ("Huddle").
is_request = true only when the line asks for work to be done now: research/look up/compare something,
or build/prototype/mock up/make something (e.g. "Huddle, research X", "can you research X",
"let's get a prototype of Y", "someone mock up Z"). Musing, opinions, questions to humans, and status
updates are NOT requests.
kind: "research" = find out / compare / analyze only; "build" = research then make something;
"prototype" = make something right away with no research needed.
title: 4-9 words. goal: a self-contained instruction for the agent including every specific the
speaker gave (audience, constraints, examples). duplicate_of: id of an ACTIVE pipeline that already
covers this request, else 0.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { room, author, text, event_id } = await req.json().catch(() => ({}));
    if (!room || !text || text.trim().split(/\s+/).length < 4) return json({ skipped: "too short" });
    // cheap pre-filter: only classify lines that look like asks
    if (!/\b(research|look (up|into)|find|compare|analy[sz]e|investigate|build|prototype|mock ?up|make|create|design|draft|huddle)\b/i.test(text)) {
      return json({ skipped: "no request words" });
    }
    const sb = db();
    const { data: active } = await sb.from("pipelines").select("id, title, status")
      .eq("room_id", room).in("status", ["proposed", "running", "waiting"]);
    const list = (active ?? []).map((p) => `#${p.id} ${p.title} (${p.status})`).join("\n") || "(none)";
    const out = await geminiJson<any>(
      [{ text: `ACTIVE PIPELINES:\n${list}\n\nLINE from ${author ?? "someone"}: "${text}"` }],
      SCHEMA, INTENT_MODEL, SYSTEM,
    );
    if (!out.is_request) return json({ request: false });
    if (out.duplicate_of) return json({ request: true, duplicate_of: out.duplicate_of });
    const p = await createPipeline(sb, {
      room, title: out.title, goal: `${out.goal}\n(Asked by ${author ?? "a teammate"}: "${text}")`,
      kind: out.kind, created_by: author ?? "huddle", origin_event_id: event_id,
    });
    return json({ request: true, pipeline_id: p.id, kind: out.kind, status: p.status });
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
