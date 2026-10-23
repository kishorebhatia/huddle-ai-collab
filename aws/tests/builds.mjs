// Builds viewed in the room, and files shared by connected AIs. Runs against a local aws/ stack (compose
// project "huddletest" on 127.0.0.1:8130) with MAIL_DEV=1 in aws/.env and no model key (nothing here needs
// a model). Usage: node aws/tests/builds.mjs aws/.env
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const env = Object.fromEntries(readFileSync(process.argv[2], "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const BASE = "http://127.0.0.1:8130";
const ANON = env.SUPABASE_ANON_KEY;
const R = `b${Date.now().toString(36)}`;
let fails = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`); if (!ok) fails++; };
const hdr = (t) => ({ "content-type": "application/json", apikey: ANON, authorization: `Bearer ${t || ANON}` });
const people = async (t, body) => (await fetch(`${BASE}/functions/v1/people`, { method: "POST", headers: hdr(t), body: JSON.stringify(body) })).json();
const sql = (q) => execSync(`docker exec -i huddletest-db-1 psql -U postgres -d huddle -tAq`, { input: q }).toString().trim();
const lastCode = (email) => [...execSync("docker logs huddletest-app-1 2>&1").toString().matchAll(new RegExp(`to=${email.replace(/[.+]/g, "\\$&")}[^\\n]*\\nYour Huddle sign-in code is (\\d{6})`, "g"))].at(-1)?.[1];
async function signIn(email) {
  await people(null, { action: "request_code", email });
  await new Promise((r) => setTimeout(r, 300));
  return (await people(null, { action: "verify_code", email, code: lastCode(email) })).token;
}
const mcpCall = async (q, name, args) => (await (await fetch(`${BASE}/mcp?${q}`, { method: "POST", headers: { ...hdr(), accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json());

// A public room with a multi-page build, and a private room with one.
await fetch(`${BASE}/rest/v1/rooms`, { method: "POST", headers: hdr(), body: JSON.stringify({ id: R, name: "Party" }) });
const pages = { "index.html": `<!doctype html><a href="agenda.html">Agenda</a>`, "agenda.html": `<!doctype html><h1>Agenda</h1>`, "css/site.css": "body{color:red}" };
const pubJob = sql(`insert into jobs (room_id, kind, title, prompt, status, output_html, files) values ('${R}', 'prototype', 'Party plan', 'x', 'done', '${pages["index.html"]}', '${JSON.stringify(pages)}'::jsonb) returning id`);
const st = await people(null, { action: "status", room: R });
check("anyone in a public room gets its key", typeof st.file_key === "string" && st.file_key.length > 10);
const k = st.file_key;
let r = await fetch(`${BASE}/p/${pubJob}/${k}/`);
check("start page opens", r.status === 200 && (await r.text()).includes("agenda.html"));
check("every page is sandboxed by the browser", /sandbox allow-scripts/.test(r.headers.get("content-security-policy") ?? ""));
check("pages aren't cached or sniffed", r.headers.get("cache-control") === "no-store" && r.headers.get("x-content-type-options") === "nosniff");
r = await fetch(`${BASE}/p/${pubJob}/${k}/agenda.html`);
check("a linked page opens", r.status === 200 && (await r.text()).includes("<h1>Agenda"));
r = await fetch(`${BASE}/p/${pubJob}/${k}/css/site.css`);
check("assets get the right type", r.status === 200 && (r.headers.get("content-type") ?? "").startsWith("text/css"));
check("a missing page is a plain not-found", (await fetch(`${BASE}/p/${pubJob}/${k}/nope.html`)).status === 404);
check("no key: refused (builds can't be opened by guessing ids)", (await fetch(`${BASE}/p/${pubJob}/-/`)).status === 403);
check("another room's key: refused", (await fetch(`${BASE}/p/${pubJob}/${(await people(null, { action: "status", room: "otherroom1" })).file_key ?? "x"}/`)).status === 403);
check("path tricks stay inside the build", (await fetch(`${BASE}/p/${pubJob}/${k}/..%2F..%2Fetc%2Fpasswd`)).status === 404);
check("a research job isn't served", (await fetch(`${BASE}/p/${sql(`insert into jobs (room_id, kind, title, prompt, status, output_md) values ('${R}', 'research', 'r', 'x', 'done', 'hi') returning id`)}/${k}/`)).status === 404);

const owner = await signIn("owner@example.com");
const PR = `${R}p`;
await fetch(`${BASE}/rest/v1/rooms`, { method: "POST", headers: hdr(owner), body: JSON.stringify({ id: PR, name: "Private party" }) });
await people(owner, { action: "make_private", room: PR, emails: "" });
const privJob = sql(`insert into jobs (room_id, kind, title, prompt, status, output_html) values ('${PR}', 'prototype', 'Secret plan', 'x', 'done', '<!doctype html>secret') returning id`);
const outsider = await people(null, { action: "status", room: PR });
check("an outsider gets no key for a private room", !outsider.file_key);
check("an outsider can't open a private build", (await fetch(`${BASE}/p/${privJob}/${k}/`)).status === 403);
const pk = (await people(owner, { action: "status", room: PR })).file_key;
check("a member opens the private build", (await (await fetch(`${BASE}/p/${privJob}/${pk}/`)).text()).includes("secret"));

// A connected AI shares a file (a type Huddle doesn't read, so no model is needed).
const link = await (await fetch(`${BASE}/mcp/links`, { method: "POST", headers: hdr(), body: JSON.stringify({ room: R, label: "Claude" }) })).json();
const q = `room=${R}&key=${link.key}&as=Claude`;
const deck = Buffer.from("PK fake pptx bytes").toString("base64");
let s = await mcpCall(q, "share_file", { name: "party slides.pptx", content_base64: deck, caption: "Draft deck" });
const sr = s.result?.structuredContent ?? {};
check("a connected AI can share a file", sr.shared === true && sr.kind === "file", JSON.stringify(s.result?.content?.[0]?.text ?? s.error ?? "").slice(0, 120));
const ev = sql(`select kind || '|' || author || '|' || (meta->>'name') || '|' || (meta->>'url') from events where room_id = '${R}' and kind = 'file' order by id desc limit 1`);
check("it shows up in the room like a teammate's upload, labelled as that AI", ev.startsWith("file|AI (Claude)|party_slides.pptx|http"), ev.slice(0, 80));
const url = ev.split("|")[3];
const got = await fetch(url.replace(/^https?:\/\/[^/]+/, BASE));
check("the file opens from the room", got.status === 200 && Buffer.from(await got.arrayBuffer()).toString().includes("fake pptx"));
check("its type is kept", (got.headers.get("content-type") ?? "").includes("presentationml"));
s = await mcpCall(q, "share_file", { name: "noextension", text: "x" });
check("a file needs a name with its extension", s.result?.isError === true);
s = await mcpCall(q, "share_file", { name: "big.bin", content_base64: Buffer.alloc(21 * 1024 * 1024).toString("base64") });
check("over 20 MB is refused", s.result?.isError === true || !!s.error);
const privLink = sql(`select count(*) from events where room_id = '${PR}'`);
s = await mcpCall(`room=${PR}`, "share_file", { name: "a.pptx", content_base64: deck });
check("no file can be shared into a private room without a member's link", sql(`select count(*) from events where room_id = '${PR}'`) === privLink && !s.result?.structuredContent?.shared);

// With no public hosting set up, a build ends at review (no publish question, no public page).
await mcpCall(q, "request_work", { goal: "Make our holiday party agenda", kind: "prototype" });
const stages = sql(`select array_to_string(stages, ',') from pipelines where room_id = '${R}' order by id desc limit 1`);
check("without public hosting, builds end at review", stages === "plan,prototype,review", stages);

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
