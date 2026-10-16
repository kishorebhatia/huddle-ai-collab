// CI eval gate for the brief prompt, logged to Arize as an experiment.
//
//   deno run -A evals/run.ts                    run the regression set against this checkout's prompt
//   deno run -A evals/run.ts --update-baseline  ...and save the scores as the new baseline
//
// Each case is built on the deployed server (which holds the model credentials) with THIS checkout's
// SYNTH_SYSTEM prompt, then judged for faithfulness and completeness. The run is uploaded to Arize as an
// experiment on the "huddle-brief-regression" dataset, so baseline and candidate can be compared there.
// Exits 1 if the scores drop below the baseline.
//
// Env: HUDDLE_URL, EVAL_TOKEN, ARIZE_API_KEY, ARIZE_SPACE_ID (Arize is optional; the gate works without it).
import { SYNTH_SYSTEM } from "../supabase/functions/_shared/prompts.ts";

type Case = { id: string; note: string; events: string };
type Result = Case & { faithfulness: number; completeness: number; explanation: string; brief: unknown; latency_ms: number; error?: string };

const HUDDLE = (Deno.env.get("HUDDLE_URL") ?? "").replace(/\/$/, "");
const TOKEN = Deno.env.get("EVAL_TOKEN") ?? "";
const ARIZE_KEY = Deno.env.get("ARIZE_API_KEY");
const SPACE = Deno.env.get("ARIZE_SPACE_ID");
const DATASET = "huddle-brief-regression";
const label = Deno.env.get("EVAL_LABEL") ?? `${Deno.env.get("GITHUB_HEAD_REF") || Deno.env.get("GITHUB_REF_NAME") || "local"}@${(Deno.env.get("GITHUB_SHA") ?? "").slice(0, 7) || "dev"}`;
const dir = new URL(".", import.meta.url);
const cases: Case[] = JSON.parse(await Deno.readTextFile(new URL("dataset.json", dir)));
const baseline = JSON.parse(await Deno.readTextFile(new URL("baseline.json", dir)).catch(() => "null"));

if (!HUDDLE || !TOKEN) {
  console.error("Set HUDDLE_URL and EVAL_TOKEN");
  Deno.exit(2);
}

async function runCase(c: Case): Promise<Result> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(`${HUDDLE}/functions/v1/eval-run`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-eval-token": TOKEN },
      body: JSON.stringify({ system: SYNTH_SYSTEM, events: c.events }),
    }).catch((e) => new Response(JSON.stringify({ error: String(e) }), { status: 599 }));
    const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    if (r.ok && !j.error) return { ...c, ...j };
    if (attempt === 1) return { ...c, faithfulness: 0, completeness: 0, explanation: "", brief: null, latency_ms: 0, error: j.error ?? `HTTP ${r.status}` };
  }
  throw new Error("unreachable");
}

// Each case runs twice and the scores are averaged: the judge varies between identical runs.
const REPEAT = Number(Deno.env.get("EVAL_REPEAT") ?? 2);
async function runCaseAvg(c: Case): Promise<Result> {
  const runs = await Promise.all(Array.from({ length: REPEAT }, () => runCase(c)));
  const ok = runs.filter((r) => !r.error);
  if (!ok.length) return runs[0];
  const avg = (k: "faithfulness" | "completeness") => ok.reduce((a, r) => a + r[k], 0) / ok.length;
  const worst = ok.reduce((a, r) => (r.faithfulness < a.faithfulness ? r : a));
  return { ...worst, faithfulness: avg("faithfulness"), completeness: avg("completeness") };
}
// Four cases at a time keeps CI around a minute without hammering the model.
const results: Result[] = [];
for (let i = 0; i < cases.length; i += 4) results.push(...await Promise.all(cases.slice(i, i + 4).map(runCaseAvg)));

const mean = (k: "faithfulness" | "completeness") => results.reduce((a, r) => a + r[k], 0) / results.length;
const scores = { faithfulness: +mean("faithfulness").toFixed(3), completeness: +mean("completeness").toFixed(3) };

// ---------- Arize: dataset + experiment ----------

async function arize(path: string, init: RequestInit = {}) {
  const r = await fetch(`https://api.arize.com${path}`, {
    ...init, headers: { authorization: `Bearer ${ARIZE_KEY}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${path} ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}
// deno-lint-ignore no-explicit-any
const listOf = (j: any, key: string): any[] => j?.[key] ?? j?.data ?? (Array.isArray(j) ? j : []);

async function logToArize() {
  const all = listOf(await arize(`/v2/datasets?space_id=${encodeURIComponent(SPACE!)}&limit=100`), "datasets");
  let ds = all.find((d) => d.name === DATASET);
  if (!ds) {
    ds = await arize("/v2/datasets", {
      method: "POST",
      body: JSON.stringify({ name: DATASET, space_id: SPACE, examples: cases.map((c) => ({ case_id: c.id, note: c.note, events: c.events })) }),
    });
  }
  const examples = listOf(await arize(`/v2/datasets/${ds.id}/examples?limit=500`), "examples");
  const exampleId = (caseId: string) => examples.find((e) => (e.case_id ?? e.additional_properties?.case_id) === caseId)?.id;
  const exp = await arize("/v2/experiments", {
    method: "POST",
    body: JSON.stringify({
      name: `ci ${label} ${new Date().toISOString().slice(0, 16)}`,
      dataset_id: ds.id,
      experiment_runs: results.map((r) => ({
        example_id: exampleId(r.id), output: JSON.stringify(r.brief ?? { error: r.error }),
        "eval.faithfulness.score": r.faithfulness, "eval.completeness.score": r.completeness,
        "eval.faithfulness.explanation": r.explanation, latency_ms: r.latency_ms,
      })),
    }),
  });
  const runIds: string[] = exp.run_ids ?? [];
  if (runIds.length) {
    await arize(`/v2/experiments/${exp.id}/runs/annotate`, {
      method: "POST",
      body: JSON.stringify({
        annotations: runIds.map((id, i) => ({
          record_id: id,
          values: [
            { name: "faithfulness", score: results[i].faithfulness, text: results[i].explanation.slice(0, 1000) },
            { name: "completeness", score: results[i].completeness },
          ],
        })),
      }),
    }).catch((e) => console.warn(`annotate runs: ${e}`));
  }
  return `Arize experiment **${exp.name}** on dataset \`${DATASET}\` (${results.length} runs, each with faithfulness and completeness).`;
}

let experimentNote = "Arize logging skipped (no ARIZE_API_KEY / ARIZE_SPACE_ID).";
if (ARIZE_KEY && SPACE) {
  try {
    experimentNote = await logToArize();
  } catch (e) {
    experimentNote = `Arize logging failed: ${e}`;
  }
}

// ---------- gate ----------
// The judge varies by a few hundredths per case between identical runs, so the gate has two parts:
// the mean may not fall much below the baseline, and no single case may collapse.
const floor = {
  faithfulness: Math.max(0.75, (baseline?.faithfulness ?? 0) - 0.05),
  completeness: Math.max(0.6, (baseline?.completeness ?? 0) - 0.2),
};
const collapsed = results.filter((r) => baseline?.cases?.[r.id] && baseline.cases[r.id].faithfulness - r.faithfulness > 0.35);
const pass = scores.faithfulness >= floor.faithfulness && scores.completeness >= floor.completeness &&
  !collapsed.length && !results.some((r) => r.error);

const rows = results.map((r) => {
  const before = baseline?.cases?.[r.id];
  const delta = before ? ` (${r.faithfulness - before.faithfulness >= 0 ? "+" : ""}${(r.faithfulness - before.faithfulness).toFixed(2)})` : "";
  return `| ${r.id} | ${r.faithfulness.toFixed(2)}${delta} | ${r.completeness.toFixed(2)} | ${(r.error ?? r.explanation).replace(/\|/g, "/").slice(0, 160)} |`;
});
const summary = [
  `## Brief prompt evals: ${pass ? "PASS" : "FAIL"}`,
  ``,
  `| | faithfulness | completeness |`, `|---|---|---|`,
  `| this change | **${scores.faithfulness}** | **${scores.completeness}** |`,
  baseline ? `| baseline | ${baseline.faithfulness} | ${baseline.completeness} |` : `| baseline | (none yet) | |`,
  `| must be at least | ${floor.faithfulness.toFixed(3)} | ${floor.completeness.toFixed(3)} |`,
  collapsed.length ? `**Collapsed cases** (faithfulness fell more than 0.35): ${collapsed.map((r) => r.id).join(", ")}` : "",
  ``, experimentNote, ``,
  `| case | faithfulness | completeness | judge's explanation |`, `|---|---|---|---|`, ...rows,
].join("\n");
console.log(summary);
const stepSummary = Deno.env.get("GITHUB_STEP_SUMMARY");
if (stepSummary) await Deno.writeTextFile(stepSummary, summary + "\n", { append: true });

if (Deno.args.includes("--update-baseline")) {
  await Deno.writeTextFile(new URL("baseline.json", dir), JSON.stringify({
    ...scores, label, at: new Date().toISOString(),
    cases: Object.fromEntries(results.map((r) => [r.id, { faithfulness: r.faithfulness, completeness: r.completeness }])),
  }, null, 2) + "\n");
  console.log("baseline updated");
}
Deno.exit(pass ? 0 : 1);
