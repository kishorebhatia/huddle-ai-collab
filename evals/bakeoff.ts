// Which Bedrock model is best for each of Huddle's jobs? Runs every model on the same tasks, scores them
// against fixed answers or a fixed judge, and writes evals/bakeoff-results.json plus Arize experiments.
//
//   AWS creds in env, then: deno run -A evals/bakeoff.ts [--only=brief,plan,review,build]
//
// Tasks (research is left out: only Nova has web grounding on Bedrock):
//   brief   the 8 CI regression conversations → brief JSON, judged for faithfulness + completeness
//   plan    8 labeled goals → deliverable / backend / keys, exact match
//   review  6 labeled artifacts (3 good, 3 flawed) → pass or revise, exact match
//   build   4 app specs → server.js + public/index.html that pass node --check, no key in code (local, no sandbox)
import { converse } from "../supabase/functions/_shared/bedrock.ts";
import { APP_SYSTEM, PLAN_SCHEMA, PLAN_SYSTEM, REVIEW_SCHEMA, REVIEW_SYSTEM, SYNTH_SCHEMA, SYNTH_SYSTEM } from "../supabase/functions/_shared/prompts.ts";

const MODELS = [
  "us.anthropic.claude-haiku-4-5-20251001-v1:0", "us.anthropic.claude-sonnet-4-6", "us.anthropic.claude-sonnet-5",
  "us.anthropic.claude-sonnet-5-5", "us.anthropic.claude-opus-5-5", "us.amazon.nova-2-lite-v1:0", "us.amazon.nova-pro-v1:0",
  "us.openai.gpt-5.5", "us.openai.gpt-6-sol",
];
const TEXT_ONLY = ["us.meta.llama4-maverick-17b-instruct-v1:0"]; // no forced tool use: build task only
const JUDGE = "us.anthropic.claude-sonnet-4-6";
const short = (m: string) => m.replace(/^us\.(anthropic|amazon|openai|meta)\./, "").replace(/-\d{8}-v1:0|-v1:0/, "");
const only = (Deno.args.find((a) => a.startsWith("--only=")) ?? "--only=brief,plan,review,build").slice(7).split(",");
const pick = Deno.args.find((a) => a.startsWith("--models="))?.slice(9).split(",");

// ---------- calling models ----------
// deno-lint-ignore no-explicit-any
type Any = any;
const lower = (s: Any): Any => Array.isArray(s) ? s.map(lower) : s && typeof s === "object"
  ? Object.fromEntries(Object.entries(s).filter(([k]) => k !== "nullable").map(([k, v]) => [k, k === "type" ? String(v).toLowerCase() : k === "properties" ? Object.fromEntries(Object.entries(v as Any).map(([pk, pv]) => [pk, lower(pv)])) : lower(v)]))
  : s;

// Some models cap output below what an app build asks for.
const MAX_OUT: Record<string, number> = { "us.amazon.nova-pro-v1:0": 10000, "us.meta.llama4-maverick-17b-instruct-v1:0": 8192 };
async function call(model: string, system: string, text: string, schema?: Any, maxTokens = 4096) {
  maxTokens = Math.min(maxTokens, MAX_OUT[model] ?? maxTokens);
  const t0 = performance.now();
  const base: Any = { system: [{ text: system }], messages: [{ role: "user", content: [{ text }] }], inferenceConfig: { maxTokens } };
  if (schema) {
    base.toolConfig = { tools: [{ toolSpec: { name: "respond", description: "Return the answer in this shape.", inputSchema: { json: lower(schema) } } }], toolChoice: { tool: { name: "respond" } } };
  }
  let res: Any;
  try {
    res = await converse(model, base);
  } catch (e) {
    if (!schema || !String(e).includes("tool_choice")) throw e;
    res = await converse(model, { ...base, system: [...base.system, { text: "Answer only by calling the respond tool." }], toolConfig: { ...base.toolConfig, toolChoice: { auto: {} } } });
  }
  const blocks = res.output?.message?.content ?? [];
  const tool = blocks.find((b: Any) => b.toolUse?.name === "respond")?.toolUse?.input;
  const out = tool ?? blocks.map((b: Any) => b.text ?? "").join("").replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, "");
  return { out, ms: Math.round(performance.now() - t0), inTok: res.usage?.inputTokens ?? 0, outTok: res.usage?.outputTokens ?? 0 };
}

async function pool<T>(items: (() => Promise<T>)[], n = 6): Promise<T[]> {
  const out: T[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await items[k](); } }));
  return out;
}

type Row = { task: string; model: string; case: string; score: number; ms: number; inTok: number; outTok: number; note: string; output: string };
const rows: Row[] = [];
async function attempt(task: string, model: string, cas: string, fn: () => Promise<Omit<Row, "task" | "model" | "case">>) {
  try {
    rows.push({ task, model, case: cas, ...(await fn()) });
  } catch (e) {
    rows.push({ task, model, case: cas, score: 0, ms: 0, inTok: 0, outTok: 0, note: `error: ${String(e).slice(0, 160)}`, output: "" });
  }
}

// ---------- brief ----------
const briefCases: { id: string; events: string }[] = JSON.parse(await Deno.readTextFile(new URL("dataset.json", import.meta.url)));
const JUDGE_SCHEMA = { type: "OBJECT", properties: { faithfulness: { type: "NUMBER" }, completeness: { type: "NUMBER" }, explanation: { type: "STRING" } }, required: ["faithfulness", "completeness", "explanation"] };
async function briefTask(model: string, c: { id: string; events: string }) {
  const r = await call(model, SYNTH_SYSTEM, `CURRENT BRIEF (JSON):\n{}\n\nLOCKED DECISIONS:\n(none)\n\nAGENT PIPELINES:\n(none)\n\nNEW EVENTS:\n${c.events}\n\nReturn the updated brief.`, SYNTH_SCHEMA, 8192);
  if (typeof r.out === "string") throw new Error("no structured brief");
  for (const k of ["new_pipelines", "obsolete_pipeline_ids", "gate_answers"]) delete r.out[k];
  const j = await call(JUDGE, "You are a strict, fair evaluator.",
    `Score a team brief against the events it was built from.\nfaithfulness 0-1: share of brief items supported by the events (invented goals, decisions or tasks lower it).\n` +
    `completeness 0-1: share of explicit decisions and questions in the events that the brief captures (1.0 if there are none).\n\nEVENTS:\n${c.events}\n\nBRIEF:\n${JSON.stringify(r.out)}`, JUDGE_SCHEMA);
  const f = Math.max(0, Math.min(1, Number(j.out.faithfulness))), cpl = Math.max(0, Math.min(1, Number(j.out.completeness)));
  return { score: +(0.7 * f + 0.3 * cpl).toFixed(3), ms: r.ms, inTok: r.inTok, outTok: r.outTok, note: `faith ${f.toFixed(2)} compl ${cpl.toFixed(2)}: ${String(j.out.explanation).slice(0, 140)}`, output: JSON.stringify(r.out) };
}

// ---------- plan ----------
const planCases = [
  { id: "research-crm", goal: "Research the top 3 CRM tools for small agencies and compare their pricing.", deliverable: "research", backend: false, keys: [] },
  { id: "tts-elevenlabs", goal: "Build a page where I type a sentence and hear it spoken with ElevenLabs.", deliverable: "app", backend: true, keys: ["ELEVEN"] },
  { id: "tip-calculator", goal: "Make a tip calculator page we can use at dinner.", deliverable: "app", backend: false, keys: [] },
  { id: "slack-bot", goal: "Build a Slack bot that posts our brief to #team every morning.", deliverable: "app", backend: true, keys: ["SLACK"] },
  { id: "research-then-pricing", goal: "Find out what our three competitors charge, then build us a pricing page with mock plans.", deliverable: "app", backend: false, keys: [] },
  { id: "github-dashboard", goal: "Prototype a dashboard of our repo's open GitHub issues using the GitHub API.", deliverable: "app", backend: true, keys: ["GITHUB"] },
  { id: "db-comparison", goal: "Compare Postgres and DynamoDB for a multi-tenant SaaS like ours.", deliverable: "research", backend: false, keys: [] },
  { id: "weather-widget", goal: "Build a weather widget for our office in New York using OpenWeather.", deliverable: "app", backend: true, keys: ["OPENWEATHER"] },
];
async function planTask(model: string, c: typeof planCases[number]) {
  const r = await call(model, PLAN_SYSTEM, `GOAL: ${c.goal}`, PLAN_SCHEMA);
  if (typeof r.out === "string") throw new Error("no structured plan");
  const keys: string[] = (r.out.required_inputs ?? []).map((k: Any) => String(k.name ?? "").toUpperCase());
  const keyOk = c.keys.length ? c.keys.every((k) => keys.some((n) => n.includes(k))) && keys.length <= c.keys.length + 1 : keys.length === 0;
  const parts = [r.out.deliverable === c.deliverable, !!r.out.needs_backend === c.backend, keyOk];
  return { score: parts.filter(Boolean).length / 3, ms: r.ms, inTok: r.inTok, outTok: r.outTok, note: `deliverable ${r.out.deliverable} backend ${r.out.needs_backend} keys ${keys.join("+") || "none"}`, output: JSON.stringify(r.out) };
}

// ---------- review ----------
const reviewCases = [
  { id: "research-good", good: true, goal: "Compare Postgres and DynamoDB for our multi-tenant SaaS.", work: "RESEARCH UNDER REVIEW:\n## Answer\nPostgres fits better: row-level security isolates tenants natively, and our joins-heavy reporting is cheap there; DynamoDB needs a partition-key design per access pattern.\n## Key findings\n- Postgres RLS enforces tenant isolation in the database (postgresql.org/docs/current/ddl-rowsecurity.html)\n- DynamoDB on-demand charges per request; single-digit ms reads at any scale (aws.amazon.com/dynamodb/pricing)\n- Ad-hoc reporting on DynamoDB usually needs an export to S3 + Athena\nSOURCES: 6" },
  { id: "research-vague", good: false, goal: "Compare Postgres and DynamoDB for our multi-tenant SaaS.", work: "RESEARCH UNDER REVIEW:\nBoth databases are popular and have pros and cons. Postgres is relational and DynamoDB is NoSQL. The best choice depends on your needs. Consider your requirements carefully.\nSOURCES: 0" },
  { id: "research-offtopic", good: false, goal: "Find the pricing of Linear, Jira and Asana for a 10-person team.", work: "RESEARCH UNDER REVIEW:\n## Answer\nLinear was founded in 2019 and is popular with startups. Jira is made by Atlassian. Asana was founded by a Facebook co-founder.\nSOURCES: 3" },
  { id: "proto-good", good: true, goal: "A tip calculator: bill amount, tip %, split between people.", work: "PROTOTYPE UNDER REVIEW (HTML):\n<!doctype html><html><body><input id=b type=number placeholder='Bill'><input id=t type=number value=18><input id=p type=number value=2><div id=o></div><script>const f=()=>{const b=+bill(),t=+document.getElementById('t').value,p=+document.getElementById('p').value||1;document.getElementById('o').textContent=`Each pays $${((b*(1+t/100))/p).toFixed(2)}`};function bill(){return document.getElementById('b').value||0}for(const id of['b','t','p'])document.getElementById(id).oninput=f;f();</script></body></html>" },
  { id: "proto-broken", good: false, goal: "A tip calculator: bill amount, tip %, split between people.", work: "PROTOTYPE UNDER REVIEW (HTML):\n<!doctype html><html><body><input id=b><button onclick=calc()>Go</button><div id=o></div><script>function calc( { document.getElementById('o').textContent = b.value * 1.18 </script></body></html>" },
  { id: "proto-wrong-thing", good: false, goal: "A tip calculator: bill amount, tip %, split between people.", work: "PROTOTYPE UNDER REVIEW (HTML):\n<!doctype html><html><body><h1>Unit converter</h1><input id=m> meters = <span id=f></span> feet<script>m.oninput=()=>f.textContent=(m.value*3.281).toFixed(2)</script></body></html>" },
];
async function reviewTask(model: string, c: typeof reviewCases[number]) {
  const r = await call(model, REVIEW_SYSTEM, `PIPELINE GOAL: ${c.goal}\n\n${c.work}`, REVIEW_SCHEMA);
  if (typeof r.out === "string") throw new Error("no structured review");
  const ok = (r.out.verdict === "pass") === c.good;
  return { score: ok ? 1 : 0, ms: r.ms, inTok: r.inTok, outTok: r.outTok, note: `${r.out.verdict} ${r.out.score}/10 (expected ${c.good ? "pass" : "revise"})`, output: JSON.stringify(r.out) };
}

// ---------- build ----------
const buildCases = [
  { id: "tts", spec: "A page where you type a sentence, press Speak, and hear it via ElevenLabs text-to-speech (voice JBFqnCBsd6RMkjVDRZzb, model eleven_flash_v2_5). SECRETS IN process.env: ELEVENLABS_API_KEY" },
  { id: "notes", spec: "A shared notes board: add a note, see all notes, delete one. Keep notes in memory on the server. SECRETS IN process.env: (none)" },
  { id: "weather", spec: "A weather card for New York using the OpenWeather current-weather API, in Fahrenheit. SECRETS IN process.env: OPENWEATHER_API_KEY" },
  { id: "poll", spec: "A one-question poll: three options, vote once per browser, live totals via polling every 2 s. SECRETS IN process.env: (none)" },
];
const tmp = await Deno.makeTempDir({ prefix: "bakeoff" });
async function nodeCheck(code: string, ext: string) {
  const f = `${tmp}/${crypto.randomUUID()}.${ext}`;
  await Deno.writeTextFile(f, code);
  const r = await new Deno.Command("node", { args: ["--check", f], stderr: "piped" }).output();
  return r.success ? "" : new TextDecoder().decode(r.stderr).split("\n").find((l) => /Error/.test(l)) ?? "syntax error";
}
async function buildTask(model: string, c: typeof buildCases[number]) {
  const r = await call(model, APP_SYSTEM, `TASK: ${c.spec}`, undefined, 16000);
  const files: Record<string, string> = {};
  for (const m of String(r.out).matchAll(/```file:([^\s`]+)\s*\n([\s\S]*?)```/g)) files[m[1].replace(/^\/+/, "")] = m[2];
  const problems: string[] = [];
  if (!files["server.js"]) problems.push("no server.js");
  if (!files["public/index.html"]) problems.push("no public/index.html");
  if (files["server.js"]) { const e = await nodeCheck(files["server.js"], "js"); if (e) problems.push(`server.js: ${e}`); }
  for (const [i, m] of [...(files["public/index.html"] ?? "").matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi)].entries()) {
    const e = await nodeCheck(m[2], /module/.test(m[1]) ? "mjs" : "js"); if (e) problems.push(`inline script ${i}: ${e}`);
  }
  if (/require\(['"](?!node:|http|fs|path|url|crypto|os)[a-z@]/.test(files["server.js"] ?? "")) problems.push("npm dependency");
  if (/(sk_|xi-api-key['"]?\s*[:=]\s*['"][A-Za-z0-9]{10,})/.test(Object.values(files).join("\n"))) problems.push("key in code");
  const checks = 4;
  return { score: +((checks - Math.min(checks, problems.length)) / checks).toFixed(2), ms: r.ms, inTok: r.inTok, outTok: r.outTok, note: problems.join("; ") || "all checks pass", output: Object.keys(files).join(", ") };
}

// ---------- run ----------
const jobs: (() => Promise<void>)[] = [];
const want = (m: string) => !pick || pick.some((p) => m.includes(p));
for (const m of MODELS.filter(want)) {
  if (only.includes("brief")) for (const c of briefCases) jobs.push(() => attempt("brief", m, c.id, () => briefTask(m, c)));
  if (only.includes("plan")) for (const c of planCases) jobs.push(() => attempt("plan", m, c.id, () => planTask(m, c)));
  if (only.includes("review")) for (const c of reviewCases) jobs.push(() => attempt("review", m, c.id, () => reviewTask(m, c)));
}
for (const m of [...MODELS, ...TEXT_ONLY].filter(want)) if (only.includes("build")) for (const c of buildCases) jobs.push(() => attempt("build", m, c.id, () => buildTask(m, c)));
console.log(`${jobs.length} runs…`);
const t0 = Date.now();
await pool(jobs, 8);
console.log(`done in ${Math.round((Date.now() - t0) / 1000)} s`);

// ---------- summarize ----------
const out = new URL("bakeoff-results.json", import.meta.url);
const prev = await Deno.readTextFile(out).then(JSON.parse).catch(() => ({ rows: [] }));
const kept = prev.rows.filter((r: Row) => !(only.includes(r.task) && want(r.model)));
const all = [...kept, ...rows];
await Deno.writeTextFile(out, JSON.stringify({ at: new Date().toISOString(), judge: JUDGE, rows: all }, null, 1));
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
for (const task of ["brief", "plan", "review", "build"].filter((t) => all.some((r: Row) => r.task === t))) {
  console.log(`\n## ${task}\n| model | score | median s | out tokens | errors |\n|---|---|---|---|---|`);
  const ms = [...new Set(all.filter((r: Row) => r.task === task).map((r: Row) => r.model))] as string[];
  const stats = ms.map((m) => {
    const rs = all.filter((r: Row) => r.task === task && r.model === m);
    return { m, score: rs.reduce((a: number, r: Row) => a + r.score, 0) / rs.length, s: median(rs.filter((r: Row) => r.ms).map((r: Row) => r.ms)) / 1000,
      out: Math.round(rs.reduce((a: number, r: Row) => a + r.outTok, 0) / Math.max(1, rs.length)), err: rs.filter((r: Row) => r.note.startsWith("error")).length };
  }).sort((a, b) => b.score - a.score || a.s - b.s);
  for (const s of stats) console.log(`| ${short(s.m)} | ${s.score.toFixed(2)} | ${s.s.toFixed(1)} | ${s.out} | ${s.err} |`);
}
