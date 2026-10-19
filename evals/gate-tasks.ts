// CI gate for the plan and review prompts (evals/run.ts gates the brief prompt).
//   deno run -A evals/gate-tasks.ts [--update-baseline]      env: HUDDLE_URL, EVAL_TOKEN (ARIZE_API_KEY, ARIZE_SPACE_ID optional)
// Each run is logged to Arize as experiments on the huddle-plan-regression and huddle-review-regression datasets.
// plan:   8 labeled goals; deliverable, backend and key names must match (score = share of the 3 that do)
// review: 14 labeled artifacts (4 good, 10 bad; 4 are real research from simulated-team runs, 4 are subtly broken)
// Fails if plan accuracy falls more than 0.1 below baseline, if review lets ANY bad artifact pass, or if
// review rejects good work more often than baseline + 0.25, or if review's mean score for bad work rises
// more than 1.5 above baseline (a softened reviewer shows up there first). Each case runs twice.
import { PLAN_SYSTEM, REVIEW_SYSTEM } from "../supabase/functions/_shared/prompts.ts";

const HUDDLE = (Deno.env.get("HUDDLE_URL") ?? "").replace(/\/$/, "");
const TOKEN = Deno.env.get("EVAL_TOKEN") ?? "";
if (!HUDDLE || !TOKEN) { console.error("Set HUDDLE_URL and EVAL_TOKEN"); Deno.exit(2); }
const dir = new URL(".", import.meta.url);
const read = async (f: string) => JSON.parse(await Deno.readTextFile(new URL(f, dir)));
const plans: { id: string; goal: string; deliverable: string; backend: boolean; keys: string[] }[] = await read("plan-cases.json");
const reviews: { id: string; good: boolean; goal: string; work: string }[] = await read("review-cases.json");
const baseline = await read("baseline-tasks.json").catch(() => null);

// deno-lint-ignore no-explicit-any
async function ask(task: "plan" | "review", system: string, input: string): Promise<any> {
  for (let i = 0; i < 2; i++) {
    const r = await fetch(`${HUDDLE}/functions/v1/eval-run`, {
      method: "POST", headers: { "content-type": "application/json", "x-eval-token": TOKEN }, body: JSON.stringify({ task, system, input }),
    }).catch(() => null);
    const j = r ? await r.json().catch(() => null) : null;
    if (j?.output) return j.output;
    if (j?.error === "events required") { // the deployed server predates these modes; the deploy after this run adds them
      console.log("Live server has no plan/review eval mode yet; skipping this gate once.");
      Deno.exit(0);
    }
  }
  throw new Error(`${task} call failed`);
}
async function pool<T>(fns: (() => Promise<T>)[], n = 4) {
  const out: T[] = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < fns.length) { const k = i++; out[k] = await fns[k](); } }));
  return out;
}

const planScores = await pool(plans.map((c) => async () => {
  const runs = await Promise.all([0, 1].map(() => ask("plan", PLAN_SYSTEM, `GOAL: ${c.goal}`)));
  const one = (o: Record<string, unknown>) => {
    const keys = ((o.required_inputs as { name: string }[]) ?? []).map((k) => String(k.name).toUpperCase());
    const keyOk = c.keys.length ? c.keys.every((k) => keys.some((n) => n.includes(k))) : keys.length === 0;
    return ([o.deliverable === c.deliverable, !!o.needs_backend === c.backend, keyOk].filter(Boolean).length) / 3;
  };
  return { id: c.id, score: (one(runs[0]) + one(runs[1])) / 2, output: runs[0] };
}));
const reviewResults = await pool(reviews.map((c) => async () => {
  const runs = await Promise.all([0, 1].map(() => ask("review", REVIEW_SYSTEM, `PIPELINE GOAL: ${c.goal}\n\n${c.work}`)));
  const passed = runs.map((o) => o.verdict === "pass");
  return { id: c.id, good: c.good, passes: passed.filter(Boolean).length, scores: runs.map((o) => o.score), output: runs[0] };
}));

const planAcc = +(planScores.reduce((a, r) => a + r.score, 0) / planScores.length).toFixed(3);
const falsePass = reviewResults.filter((r) => !r.good && r.passes > 0);
const goods = reviewResults.filter((r) => r.good);
const falseRejectRate = +(goods.filter((r) => r.passes < 2).length / Math.max(1, goods.length)).toFixed(3);
const badMean = +(reviewResults.filter((r) => !r.good).flatMap((r) => r.scores.map(Number)).reduce((a, b, _i, arr) => a + b / arr.length, 0)).toFixed(2);
const ceilBad = (baseline?.review_bad_mean_score ?? 3) + 1.5;
const floorPlan = Math.max(0.75, (baseline?.plan_accuracy ?? 0) - 0.1);
const ceilReject = Math.min(0.75, (baseline?.review_false_reject ?? 0.5) + 0.25);
const pass = planAcc >= floorPlan && falsePass.length === 0 && falseRejectRate <= ceilReject && badMean <= ceilBad;

const summaryBody = [
  `## Plan and review prompt evals: ${pass ? "PASS" : "FAIL"}`, ``,
  `| check | this change | baseline | must be |`, `|---|---|---|---|`,
  `| plan accuracy (${plans.length} goals) | **${planAcc}** | ${baseline?.plan_accuracy ?? "-"} | ≥ ${floorPlan.toFixed(2)} |`,
  `| review: bad work passed (${reviews.length - goods.length} bad) | **${falsePass.length}** | 0 | 0 |`,
  `| review: mean score for bad work (0-10) | **${badMean}** | ${baseline?.review_bad_mean_score ?? "-"} | ≤ ${ceilBad.toFixed(2)} |`,
  `| review: good work rejected (${goods.length} good) | **${falseRejectRate}** | ${baseline?.review_false_reject ?? "-"} | ≤ ${ceilReject.toFixed(2)} |`, ``,
  `| review case | label | passed (of 2) | scores |`, `|---|---|---|---|`,
  ...reviewResults.map((r) => `| ${r.id} | ${r.good ? "good" : "bad"} | ${r.passes} | ${r.scores.join(", ")} |`),
  ``, `| plan case | score |`, `|---|---|`, ...planScores.map((r) => `| ${r.id} | ${r.score.toFixed(2)} |`),
].join("\n");
// ---------- Arize: one experiment per task on its regression dataset ----------
const ARIZE_KEY = Deno.env.get("ARIZE_API_KEY"), SPACE = Deno.env.get("ARIZE_SPACE_ID");
async function arize(path: string, init: RequestInit = {}) {
  const r = await fetch(`https://api.arize.com${path}`, { ...init, headers: { authorization: `Bearer ${ARIZE_KEY}`, "content-type": "application/json" } });
  const text = await r.text();
  if (!r.ok) throw new Error(`${path} ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}
// deno-lint-ignore no-explicit-any
const listOf = (j: any, key: string): any[] => j?.[key] ?? j?.data ?? (Array.isArray(j) ? j : []);
async function experiment(dataset: string, examples: Record<string, unknown>[], runs: { id: string; output: unknown; score: number }[]) {
  let ds = listOf(await arize(`/v2/datasets?space_id=${encodeURIComponent(SPACE!)}&limit=100`), "datasets").find((d) => d.name === dataset);
  if (!ds) ds = await arize("/v2/datasets", { method: "POST", body: JSON.stringify({ name: dataset, space_id: SPACE, examples }) });
  const ex = listOf(await arize(`/v2/datasets/${ds.id}/examples?limit=500`), "examples");
  const exampleId = (id: string) => ex.find((e) => (e.case_id ?? e.additional_properties?.case_id) === id)?.id;
  const label = Deno.env.get("GITHUB_SHA")?.slice(0, 7) ?? "local";
  await arize("/v2/experiments", { method: "POST", body: JSON.stringify({
    name: `ci ${label} ${new Date().toISOString().slice(0, 16)}`, dataset_id: ds.id,
    experiment_runs: runs.filter((r) => exampleId(r.id)).map((r) => ({ example_id: exampleId(r.id), output: JSON.stringify(r.output), "eval.correct.score": r.score })),
  }) });
}
let arizeNote = "Arize logging skipped (no ARIZE_API_KEY / ARIZE_SPACE_ID).";
if (ARIZE_KEY && SPACE) {
  try {
    await experiment("huddle-plan-regression", plans.map((c) => ({ case_id: c.id, goal: c.goal, expected: JSON.stringify({ deliverable: c.deliverable, backend: c.backend, keys: c.keys }) })), planScores);
    await experiment("huddle-review-regression", reviews.map((c) => ({ case_id: c.id, label: c.good ? "good" : "bad", goal: c.goal, work: c.work.slice(0, 20000) })),
      reviewResults.map((r) => ({ id: r.id, output: r.output, score: (r.good ? r.passes : 2 - r.passes) / 2 })));
    arizeNote = "Logged to Arize: experiments on `huddle-plan-regression` and `huddle-review-regression`.";
  } catch (e) {
    arizeNote = `Arize logging failed: ${e}`;
  }
}
const summary = summaryBody + "\n\n" + arizeNote;
console.log(summary);
const stepSummary = Deno.env.get("GITHUB_STEP_SUMMARY");
if (stepSummary) await Deno.writeTextFile(stepSummary, summary + "\n", { append: true });
if (Deno.args.includes("--update-baseline")) {
  await Deno.writeTextFile(new URL("baseline-tasks.json", dir), JSON.stringify({ plan_accuracy: planAcc, review_false_reject: falseRejectRate, review_bad_mean_score: badMean, at: new Date().toISOString() }, null, 2) + "\n");
  console.log("baseline updated");
}
Deno.exit(pass ? 0 : 1);
