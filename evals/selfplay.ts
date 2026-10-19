// Simulated teams, end to end, on the live site. Each scenario is a short team conversation posted into a
// fresh public room over Huddle's MCP server, ending in a request. Huddle runs it in Full auto; this script
// follows it, supplies the ElevenLabs key when a build asks, stops the build's Daytona sandbox as soon as
// the run is over, and writes evals/selfplay-results.json.
//
//   HUDDLE_URL, ANON_KEY, DAYTONA_API_KEY, ELEVENLABS_API_KEY in env; deno run -A evals/selfplay.ts [--only=id,id]
const SITE = (Deno.env.get("HUDDLE_URL") ?? "https://d2k5rbdeilbp1b.cloudfront.net").replace(/\/$/, "");
const ANON = Deno.env.get("ANON_KEY")!;
const DAYTONA = Deno.env.get("DAYTONA_API_KEY")!;
const EL_KEY = Deno.env.get("ELEVENLABS_API_KEY") ?? "";
const RUN = `sp${Date.now().toString(36).slice(-5)}`;
const CONCURRENCY = 3; // at most 3 builds (and sandboxes) at once
const TIMEOUT_MS = 14 * 60_000;

type Scenario = { id: string; kind: "research" | "static" | "voice"; lines: [string, string][] };
const S: Scenario[] = [
  { id: "pm-pricing", kind: "research", lines: [["Maya", "We need to pick a project tracker before Monday."], ["Sam", "Linear, Jira or Asana. Budget is tight, we're 10 people."], ["Maya", "Huddle, research what Linear, Jira and Asana cost for a 10-person team, with sources."]] },
  { id: "vector-db", kind: "research", lines: [["Leo", "For the RAG prototype I don't want to run a big service."], ["Sam", "Something open source we can self-host on one box."], ["Leo", "Huddle, research the best open-source vector databases for a small RAG app and compare them."]] },
  { id: "eu-ai-act", kind: "research", lines: [["Maya", "Our meeting-notes tool records EU customers."], ["Zain", "Do we fall under the EU AI Act at all?"], ["Maya", "Huddle, research what the EU AI Act requires from a meeting-notes startup like ours."]] },
  { id: "judging", kind: "research", lines: [["Sam", "Demo is in two hours."], ["Leo", "Let's tailor it to how judges actually score."], ["Sam", "Huddle, research how hackathon judges score demos and what they look for in 3 minutes."]] },
  { id: "tip-split", kind: "static", lines: [["Maya", "Dinner tonight with the whole team."], ["Sam", "Splitting the bill is always a mess."], ["Maya", "Huddle, build a tip calculator page: bill amount, tip percentage, number of people, and what each person pays. No research needed."]] },
  { id: "retro", kind: "static", lines: [["Leo", "Retro after this sprint."], ["Zain", "Two columns are enough: went well, to improve."], ["Leo", "Huddle, build a retro board where you type a card and add it to Went well or To improve. No research needed."]] },
  { id: "standup-timer", kind: "static", lines: [["Sam", "Standups keep running long."], ["Maya", "Two minutes each, and rotate who goes next."], ["Sam", "Huddle, build a standup timer: enter names, it gives each person 2 minutes and moves to the next. No research needed."]] },
  { id: "lunch-wheel", kind: "static", lines: [["Zain", "We waste 15 minutes picking lunch every day."], ["Leo", "Let's just spin a wheel."], ["Zain", "Huddle, build a lunch picker: type restaurant options and it picks one at random with a spin animation. No research needed."]] },
  { id: "meeting-cost", kind: "static", lines: [["Maya", "This meeting has eight people in it."], ["Sam", "I wonder what it costs per minute."], ["Maya", "Huddle, build a meeting cost calculator: number of people, average hourly rate, a running timer and the cost so far. No research needed."]] },
  { id: "mini-kanban", kind: "static", lines: [["Leo", "We just need a tiny board for the hackathon tasks."], ["Zain", "Todo, doing, done."], ["Leo", "Huddle, build a mini kanban: add a card, move it between Todo, Doing and Done with buttons. No research needed."]] },
  { id: "voice-greeter", kind: "voice", lines: [["Maya", "The lobby screen should greet visitors out loud."], ["Sam", "We already use ElevenLabs."], ["Maya", "Huddle, build a page where you type a greeting, press Speak and hear it with ElevenLabs, voice JBFqnCBsd6RMkjVDRZzb, model eleven_flash_v2_5, no other ElevenLabs endpoints."]] },
  { id: "pronounce", kind: "voice", lines: [["Zain", "Customers keep mispronouncing our product names."], ["Leo", "A page that says them clearly would help sales."], ["Zain", "Huddle, build a pronunciation helper: type a word or name, press Play and hear it spoken slowly with ElevenLabs, voice JBFqnCBsd6RMkjVDRZzb, model eleven_flash_v2_5, no other ElevenLabs endpoints."]] },
];

// deno-lint-ignore no-explicit-any
type Any = any;
const rest = (path: string, init: RequestInit = {}) => fetch(`${SITE}/rest/v1/${path}`, {
  ...init, headers: { apikey: ANON, authorization: `Bearer ${ANON}`, "content-type": "application/json", ...(init.headers ?? {}) },
});
const fnCall = async (name: string, body: unknown) =>
  (await fetch(`${SITE}/functions/v1/${name}`, { method: "POST", headers: { apikey: ANON, authorization: `Bearer ${ANON}`, "content-type": "application/json" }, body: JSON.stringify(body) })).json();
const mcp = async (room: string, name: string, args: Any, persona: string) => {
  const r = await fetch(`${SITE}/mcp?room=${room}&as=${encodeURIComponent(persona)}`, {
    method: "POST", headers: { "content-type": "application/json", "mcp-session-id": `${room}-${persona}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  return JSON.parse(await r.text(), (_k, v) => v);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function stopSandboxes(room: string) {
  const list = await (await fetch("https://app.daytona.io/api/sandbox", { headers: { authorization: `Bearer ${DAYTONA}` } })).json();
  const ours = (list.items ?? list).filter((x: Any) => x.labels?.room === room && x.state === "started");
  for (const sb of ours) await fetch(`https://app.daytona.io/api/sandbox/${sb.id}/stop`, { method: "POST", headers: { authorization: `Bearer ${DAYTONA}` } });
  return ours.length;
}

async function play(sc: Scenario) {
  const room = `${RUN}-${sc.id}`;
  const t0 = Date.now();
  await rest("rooms", { method: "POST", body: JSON.stringify({ id: room, mode: "full", name: sc.id }) });
  for (const [who, text] of sc.lines) { await mcp(room, "post", { text, kind: "note" }, who); await sleep(800); }
  let p: Any = null;
  let keyGiven = false;
  while (Date.now() - t0 < TIMEOUT_MS) {
    await sleep(10_000);
    p = (await (await rest(`pipelines?room_id=eq.${room}&select=id,status,stages,current,gate,host_url&order=id`)).json())[0];
    if (!p) continue;
    if (p.status === "waiting" && p.gate?.kind === "secret" && !keyGiven && EL_KEY) {
      for (const i of p.gate.inputs ?? []) await fnCall("secrets", { room, action: "set", name: i.name, value: EL_KEY });
      await fnCall("orchestrate", { pipeline_id: p.id, action: "approve" });
      keyGiven = true;
      continue;
    }
    if (p.status === "waiting") await fnCall("orchestrate", { pipeline_id: p.id, action: "skip" }); // full auto shouldn't stop; don't let it hang
    if (["done", "failed", "stopped"].includes(p.status)) break;
  }
  const stopped = await stopSandboxes(room);
  const jobs = p ? await (await rest(`jobs?pipeline_id=eq.${p.id}&select=kind,status,error,meta&order=id`)).json() : [];
  const evals: Record<string, number> = {};
  for (const j of jobs) for (const [k, v] of Object.entries(j.meta?.evals ?? {})) evals[k] = Number((v as Any).score);
  const out = {
    id: sc.id, kind: sc.kind, room, pipeline_id: p?.id ?? null, status: p?.status ?? "not started", stages: p?.stages ?? [],
    host_url: p?.host_url ?? null, minutes: +((Date.now() - t0) / 60000).toFixed(1), evals,
    failed_jobs: jobs.filter((j: Any) => j.status === "failed").map((j: Any) => `${j.kind}: ${String(j.error ?? "").slice(0, 160)}`),
    sandboxes_stopped: stopped,
  };
  console.log(`${sc.id}: ${out.status} in ${out.minutes} min ${JSON.stringify(evals)} ${out.failed_jobs.join(" | ")}`);
  return out;
}

const only = Deno.args.find((a) => a.startsWith("--only="))?.slice(7).split(",");
const queue = S.filter((s) => !only || only.includes(s.id));
const results: Any[] = [];
let i = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => { while (i < queue.length) results.push(await play(queue[i++])); }));
const file = new URL("selfplay-results.json", import.meta.url);
await Deno.writeTextFile(file, JSON.stringify({ run: RUN, at: new Date().toISOString(), results }, null, 1));
const ok = results.filter((r) => r.status === "done" && (r.kind === "research" || r.host_url));
console.log(`\n${ok.length}/${results.length} finished end to end. Sandboxes stopped: ${results.reduce((a, r) => a + r.sandboxes_stopped, 0)}`);
