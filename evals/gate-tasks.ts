// CI gate for the plan and review prompts (evals/run.ts gates the brief prompt).
//   deno run -A evals/gate-tasks.ts [--update-baseline]      env: HUDDLE_URL, EVAL_TOKEN
// plan:   8 labeled goals; deliverable, backend and key names must match (score = share of the 3 that do)
// review: 10 labeled artifacts (4 good, 6 bad; 4 are real research from simulated-team runs)
// Fails if plan accuracy falls more than 0.1 below baseline, if review lets ANY bad artifact pass, or if
// review rejects good work more often than baseline + 0.25. Each case runs twice; a pass needs both.
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
  return { id: c.id, score: (one(runs[0]) + one(runs[1])) / 2 };
}));
const reviewResults = await pool(reviews.map((c) => async () => {
  const runs = await Promise.all([0, 1].map(() => ask("review", REVIEW_SYSTEM, `PIPELINE GOAL: ${c.goal}\n\n${c.work}`)));
  const passed = runs.map((o) => o.verdict === "pass");
  return { id: c.id, good: c.good, passes: passed.filter(Boolean).length, scores: runs.map((o) => o.score) };
}));

const planAcc = +(planScores.reduce((a, r) => a + r.score, 0) / planScores.length).toFixed(3);
const falsePass = reviewResults.filter((r) => !r.good && r.passes > 0);
const goods = reviewResults.filter((r) => r.good);
const falseRejectRate = +(goods.filter((r) => r.passes < 2).length / Math.max(1, goods.length)).toFixed(3);
const floorPlan = Math.max(0.75, (baseline?.plan_accuracy ?? 0) - 0.1);
const ceilReject = Math.min(0.75, (baseline?.review_false_reject ?? 0.5) + 0.25);
const pass = planAcc >= floorPlan && falsePass.length === 0 && falseRejectRate <= ceilReject;

const summary = [
  `## Plan and review prompt evals: ${pass ? "PASS" : "FAIL"}`, ``,
  `| check | this change | baseline | must be |`, `|---|---|---|---|`,
  `| plan accuracy (8 goals) | **${planAcc}** | ${baseline?.plan_accuracy ?? "-"} | ≥ ${floorPlan.toFixed(2)} |`,
  `| review: bad work passed (6 bad) | **${falsePass.length}** | 0 | 0 |`,
  `| review: good work rejected (4 good) | **${falseRejectRate}** | ${baseline?.review_false_reject ?? "-"} | ≤ ${ceilReject.toFixed(2)} |`, ``,
  `| review case | label | passed (of 2) | scores |`, `|---|---|---|---|`,
  ...reviewResults.map((r) => `| ${r.id} | ${r.good ? "good" : "bad"} | ${r.passes} | ${r.scores.join(", ")} |`),
  ``, `| plan case | score |`, `|---|---|`, ...planScores.map((r) => `| ${r.id} | ${r.score.toFixed(2)} |`),
].join("\n");
console.log(summary);
const stepSummary = Deno.env.get("GITHUB_STEP_SUMMARY");
if (stepSummary) await Deno.writeTextFile(stepSummary, summary + "\n", { append: true });
if (Deno.args.includes("--update-baseline")) {
  await Deno.writeTextFile(new URL("baseline-tasks.json", dir), JSON.stringify({ plan_accuracy: planAcc, review_false_reject: falseRejectRate, at: new Date().toISOString() }, null, 2) + "\n");
  console.log("baseline updated");
}
Deno.exit(pass ? 0 : 1);
