// POST { task: "plan" | "review", system?, input } -> one plan or review with the PR's prompt (scored by CI).
// POST { system?, events, run? } with header x-eval-token -> runs ONE regression case for CI:
// builds a brief from `events` using `system` (the brief prompt from the pull request; defaults to
// the deployed one) and judges it. Returns the brief and its scores. evals/run.ts calls this per case.
import { cors, FAST_MODEL, geminiJson, json, SMART_MODEL } from "../_shared/util.ts";
import { PLAN_SCHEMA, PLAN_SYSTEM, REVIEW_SCHEMA, REVIEW_SYSTEM, SYNTH_SCHEMA, SYNTH_SYSTEM } from "../_shared/prompts.ts";
import { judgeBrief } from "../_shared/evals.ts";
import { current } from "../_shared/trace.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const token = Deno.env.get("EVAL_TOKEN");
  if (!token || req.headers.get("x-eval-token") !== token) return json({ error: "unauthorized" }, 401);
  try {
    const { system, events, task, input } = await req.json();
    if (task === "plan" || task === "review") {
      // Same models and schemas as production, with the prompt under test. CI scores the answer.
      const t1 = Date.now();
      const out = await geminiJson<Record<string, unknown>>([{ text: String(input ?? "") }],
        task === "plan" ? PLAN_SCHEMA : REVIEW_SCHEMA, FAST_MODEL, String(system || (task === "plan" ? PLAN_SYSTEM : REVIEW_SYSTEM)),
        task === "review" ? { thinkingConfig: { thinkingLevel: "low" } } : undefined);
      return json({ output: out, latency_ms: Date.now() - t1, trace_id: current()?.traceId });
    }
    if (!events) return json({ error: "events required" }, 400);
    const t0 = Date.now();
    const brief = await geminiJson<Record<string, unknown>>(
      [{ text: `CURRENT BRIEF (JSON):\n{}\n\nLOCKED DECISIONS:\n(none)\n\nAGENT PIPELINES:\n(none)\n\nNEW EVENTS:\n${events}\n\nReturn the updated brief.` }],
      SYNTH_SCHEMA, SMART_MODEL, String(system || SYNTH_SYSTEM),
    );
    const ms = Date.now() - t0;
    for (const k of ["new_pipelines", "obsolete_pipeline_ids", "gate_answers"]) delete brief[k];
    const v = await judgeBrief(events, brief);
    return json({
      brief, latency_ms: ms, trace_id: current()?.traceId,
      faithfulness: v.score, completeness: Number(v.completeness ?? 0), explanation: v.explanation, unsupported: v.unsupported ?? [],
    });
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
