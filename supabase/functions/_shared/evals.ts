// Evals and the learning loop.
//   judge*()     LLM-as-judge checks (Bedrock Claude Haiku, via geminiJson), each traced as an EVALUATOR span
//   recordEval() writes a score to Arize (span annotation), to the evals table, and onto the job card;
//                a low score becomes a one-line lesson that later prompts for that stage include
import { db, FAST_MODEL, geminiJson } from "./util.ts";
import { annotate, current, span } from "./trace.ts";

// Below these, a score teaches the agent a lesson.
const LEARN_BELOW: Record<string, number> = {
  review_score: 0.7, groundedness: 0.7, faithfulness: 0.8, smoke_test: 0.5, build_success: 0.5,
};
// Which prompt a lesson from each eval improves.
const STAGE_OF: Record<string, string> = {
  groundedness: "research", faithfulness: "synthesize", smoke_test: "prototype", build_success: "prototype",
};

type Verdict = { score: number; explanation: string; [k: string]: unknown };

const JUDGE_SCHEMA = (extra: Record<string, unknown> = {}) => ({
  type: "OBJECT",
  properties: {
    score: { type: "NUMBER", description: "0.0 (fails) to 1.0 (fully meets the criterion)" },
    explanation: { type: "STRING", description: "one or two sentences naming the specific problems" },
    ...extra,
  },
  required: ["score", "explanation", ...Object.keys(extra)],
});
const clamp = (v: Verdict) => ({ ...v, score: Math.max(0, Math.min(1, Number(v.score) || 0)) });

function judge(name: string, prompt: string, extra: Record<string, unknown> = {}): Promise<Verdict> {
  return span(`eval.${name}`, "EVALUATOR", { "input.value": prompt.slice(0, 8000) }, async (s) => {
    const v = clamp(await geminiJson<Verdict>([{ text: prompt }], JUDGE_SCHEMA(extra), FAST_MODEL,
      "You are a strict, fair evaluator. Judge only against the criterion and the evidence given."));
    s.set({ "output.value": JSON.stringify(v), [`eval.${name}.score`]: v.score, [`eval.${name}.explanation`]: v.explanation });
    return v;
  });
}

/** Does the brief say only what the events support, and does it capture what was decided and asked? */
export function judgeBrief(eventsText: string, brief: unknown) {
  return judge("faithfulness",
    `CRITERION: faithfulness of a team's live brief to what was actually said.\n` +
    `Score 1.0 when every goal, decision, question and next step in the BRIEF is supported by the EVENTS, ` +
    `nothing is stated as decided that nobody decided, and every explicit decision or question in the EVENTS appears. ` +
    `Subtract for each invented or unsupported item and each missed explicit decision.\n\n` +
    `EVENTS:\n${eventsText}\n\nBRIEF (JSON):\n${JSON.stringify(brief)}`,
    { completeness: { type: "NUMBER", description: "0-1: share of explicit decisions/questions in EVENTS that the brief captures; 1.0 when the EVENTS contain none" },
      unsupported: { type: "ARRAY", items: { type: "STRING" } } });
}

/** Is every claim in the research backed by the pages Anchor actually read? */
export function judgeGrounding(brief: string, pages: { url: string; text: string }[]) {
  return judge("groundedness",
    `CRITERION: groundedness. Score the share of factual claims in the RESEARCH that are supported by the ` +
    `SOURCE PAGES below (read in a browser just now). Claims about the team's own plans don't count.\n\n` +
    `RESEARCH:\n${brief}\n\n` + pages.map((p, i) => `SOURCE PAGE ${i + 1} (${p.url}):\n${p.text.slice(0, 6000)}`).join("\n\n"),
    { unsupported_claims: { type: "ARRAY", items: { type: "STRING" } } });
}

/** Record an eval everywhere it is useful, and learn from it when it's low. */
export async function recordEval(e: {
  name: string; score: number; explanation: string; room: string;
  jobId?: number; pipelineId?: number; stage?: string; task?: string;
}) {
  const ctx = current();
  if (ctx) annotate(ctx.spanId, [{ name: e.name, score: e.score, text: e.explanation.slice(0, 1000) }]);
  const sb = db();
  await sb.from("evals").insert({
    room_id: e.room, job_id: e.jobId ?? null, pipeline_id: e.pipelineId ?? null, name: e.name,
    score: e.score, explanation: e.explanation, trace_id: ctx?.traceId ?? null, span_id: ctx?.spanId ?? null,
  });
  if (e.jobId) {
    const { data: job } = await sb.from("jobs").select("meta").eq("id", e.jobId).maybeSingle();
    const meta = job?.meta ?? {};
    meta.evals = { ...(meta.evals ?? {}), [e.name]: { score: e.score, explanation: e.explanation } };
    await sb.from("jobs").update({ meta }).eq("id", e.jobId);
  }
  if (e.score < (LEARN_BELOW[e.name] ?? 0.7)) {
    await learn({ ...e, stage: e.stage ?? STAGE_OF[e.name] ?? "research" }).catch((err) => console.error("learn", err));
  }
}

async function learn(e: { name: string; score: number; explanation: string; room: string; jobId?: number; stage: string; task?: string }) {
  const { lesson } = await span("learn.distill_lesson", "CHAIN", { "input.value": e.explanation }, () =>
    geminiJson<{ lesson: string }>(
      [{ text:
        `An AI agent's ${e.stage} step scored ${e.score.toFixed(2)} on "${e.name}".\nWhy: ${e.explanation}\n` +
        (e.task ? `The task was: ${e.task.slice(0, 600)}\n` : "") +
        `Write ONE short, general instruction (max 25 words) that would prevent this in future ${e.stage} work. ` +
        `Make it reusable for other tasks, not specific to this one.` }],
      { type: "OBJECT", properties: { lesson: { type: "STRING" } }, required: ["lesson"] },
      FAST_MODEL,
    ));
  if (!lesson?.trim()) return;
  const sb = db();
  await sb.from("lessons").insert({ stage: e.stage, text: lesson.trim(), eval_name: e.name, score: e.score, from_job_id: e.jobId ?? null });
  await sb.from("events").insert({
    room_id: e.room, author: "huddle", kind: "system",
    text: `Learned from a low ${e.name.replace("_", " ")} (${e.score.toFixed(2)}): ${lesson.trim()}`,
    meta: { lesson: true, job_id: e.jobId ?? null },
  });
}

/** The latest lessons for a stage, ready to append to its prompt. */
export async function lessonsFor(stage: string): Promise<string> {
  const { data } = await db().from("lessons").select("text").eq("stage", stage).order("id", { ascending: false }).limit(6);
  if (!data?.length) return "";
  return `\n\nLESSONS FROM EARLIER RUNS (these mistakes scored low before; follow them):\n` +
    data.map((l) => `- ${l.text}`).join("\n");
}
