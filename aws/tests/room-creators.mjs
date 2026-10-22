// Personal-server checks: with ROOM_CREATORS=owner@example.com, nobody else can start a huddle or reach the
// AI through a made-up room, by any door, while rooms the owner shares still work.
// Runs against a local aws/ stack (compose project "huddletest" on 127.0.0.1:8130) with MAIL_DEV=1 and
// ROOM_CREATORS=owner@example.com in aws/.env. Usage: node aws/tests/room-creators.mjs aws/.env
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const env = Object.fromEntries(readFileSync(process.argv[2], "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const BASE = "http://127.0.0.1:8130";
const ANON = env.SUPABASE_ANON_KEY;
const FAKE = `nope${Date.now().toString(36)}`;
let fails = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`); if (!ok) fails++; };

const hdr = (t) => ({ "content-type": "application/json", apikey: ANON, authorization: `Bearer ${t || ANON}` });
const people = async (t, body) => { const r = await fetch(`${BASE}/functions/v1/people`, { method: "POST", headers: hdr(t), body: JSON.stringify(body) }); return { status: r.status, ...(await r.json().catch(() => ({}))) }; };
const fnCall = async (t, name, body) => (await fetch(`${BASE}/functions/v1/${name}`, { method: "POST", headers: hdr(t), body: JSON.stringify(body) })).status;
const rest = async (t, path, init = {}) => { const r = await fetch(`${BASE}/rest/v1/${path}`, { ...init, headers: { ...hdr(t), prefer: "return=representation", ...(init.headers || {}) } }); return { status: r.status, body: await r.json().catch(() => null) }; };
const lastCode = (email) => [...execSync("docker logs huddletest-app-1 2>&1").toString().matchAll(new RegExp(`to=${email.replace(/[.+]/g, "\\$&")}[^\\n]*\\nYour Huddle sign-in code is (\\d{6})`, "g"))].at(-1)?.[1];
async function signIn(email) {
  await people(null, { action: "request_code", email });
  await new Promise((r) => setTimeout(r, 300));
  return (await people(null, { action: "verify_code", email, code: lastCode(email) })).token;
}
const mcp = async (q, t) => (await (await fetch(`${BASE}/mcp?${q}`, { method: "POST", headers: { ...hdr(t), accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_brief", arguments: {} } }) })).text());
function wsJoin(token, room) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:8130/realtime/v1/websocket?apikey=${ANON}&vsn=1.0.0`);
    ws.onopen = () => ws.send(JSON.stringify({ topic: `realtime:room-${room}`, event: "phx_join", ref: "1", join_ref: "1", payload: { config: { broadcast: { self: false }, presence: { key: "x" } }, access_token: token || ANON } }));
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.event === "phx_reply") { ws.close(); resolve(d.payload?.status); } };
    ws.onerror = () => resolve("error");
    setTimeout(() => resolve("timeout"), 4000);
  });
}

const owner = await signIn("owner@example.com");
const stranger = await signIn("stranger@example.com");

for (const [who, t] of [["anonymous", null], ["signed-in stranger", stranger]]) {
  const a = await people(t, { action: "can_create" });
  check(`${who}: told they can't start huddles`, a.locked === true && a.can_create === false);
  check(`${who}: can't create a room`, (await rest(t, "rooms", { method: "POST", body: JSON.stringify({ id: FAKE }) })).status >= 400);
  check(`${who}: can't post into a made-up room`, (await rest(t, "events", { method: "POST", body: JSON.stringify({ room_id: FAKE, author: "x", kind: "note", text: "hi" }) })).status >= 400);
  check(`${who}: can't use the AI on a made-up room (transcribe)`, (await fnCall(t, "transcribe", { room: FAKE, author: "x", text: "hello" })) === 403);
  check(`${who}: can't use the AI on a made-up room (brain-api)`, (await fnCall(t, "brain-api", { room: FAKE, author: "x", text: "hi" })) === 403);
  check(`${who}: can't use the AI on a made-up room (intake)`, (await fnCall(t, "intake", { room: FAKE, author: "x", text: "Huddle, research cats" })) === 403);
  const up = await fetch(`${BASE}/storage/v1/object/board/${FAKE}/files/a.txt`, { method: "POST", headers: { authorization: `Bearer ${t || ANON}`, "content-type": "text/plain" }, body: "x" });
  check(`${who}: can't upload into a made-up room`, up.status === 403);
  check(`${who}: can't join live updates of a made-up room`, (await wsJoin(t, FAKE)) !== "ok");
  check(`${who}: AI link to a made-up room refused`, /doesn't exist/i.test(await mcp(`room=${FAKE}`, t)));
  check(`${who}: can't make an AI link for a made-up room`, (await fetch(`${BASE}/mcp/links`, { method: "POST", headers: hdr(t), body: JSON.stringify({ room: FAKE }) })).status === 403);
  const st = await people(t, { action: "status", room: FAKE });
  check(`${who}: a made-up room reads as not existing`, st.exists === false && st.can_create === false);
}
check("no room was created by anyone else", execSync(`docker exec huddletest-db-1 psql -U postgres -d huddle -tAc "select count(*) from rooms where id='${FAKE}'"`).toString().trim() === "0");

// The owner starts huddles as usual, and a public one they share works for anyone with the link.
const oa = await people(owner, { action: "can_create" });
check("owner may start huddles", oa.can_create === true);
const SHARED = `${FAKE}s`;
check("owner creates a room", (await rest(owner, "rooms", { method: "POST", body: JSON.stringify({ id: SHARED, name: "Shared" }) })).status === 201);
check("guest can read the shared public room", Array.isArray((await rest(null, `rooms?id=eq.${SHARED}&select=id`)).body) && (await rest(null, `rooms?id=eq.${SHARED}&select=id`)).body.length === 1);
check("guest can post in the shared public room", (await rest(null, "events", { method: "POST", body: JSON.stringify({ room_id: SHARED, author: "guest", kind: "note", text: "hello" }) })).status === 201);
check("guest can use the shared room's tools", (await fnCall(null, "brain-api", { room: SHARED, author: "guest", text: "a finding" })) !== 403);
check("guest can join the shared room's live updates", (await wsJoin(null, SHARED)) === "ok");
check("owner can use a made-up room id (it becomes theirs)", (await wsJoin(owner, `${FAKE}o`)) === "ok");

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
