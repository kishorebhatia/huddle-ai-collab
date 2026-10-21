// Private huddle checks: an outsider is refused at every door, and the owner/member/ask/invite flows work.
// Runs against a local aws/ stack started as compose project "huddletest" on 127.0.0.1:8130 with MAIL_DEV=1
// in aws/.env (codes and invites are read from the app's log). Usage: node aws/tests/private-huddles.mjs aws/.env
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const env = Object.fromEntries(readFileSync(process.argv[2], "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const BASE = "http://127.0.0.1:8130";
const ANON = env.SUPABASE_ANON_KEY;
const ROOM = `p${Date.now().toString(36)}`;
let fails = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`); if (!ok) fails++; };

const hdr = (t) => ({ "content-type": "application/json", apikey: ANON, authorization: `Bearer ${t || ANON}` });
const people = async (t, body) => { const r = await fetch(`${BASE}/functions/v1/people`, { method: "POST", headers: hdr(t), body: JSON.stringify(body) }); return { status: r.status, ...(await r.json().catch(() => ({}))) }; };
const fnCall = async (t, name, body) => (await fetch(`${BASE}/functions/v1/${name}`, { method: "POST", headers: hdr(t), body: JSON.stringify(body) })).status;
const rest = async (t, path, init = {}) => { const r = await fetch(`${BASE}/rest/v1/${path}`, { ...init, headers: { ...hdr(t), prefer: "return=representation", ...(init.headers || {}) } }); return { status: r.status, body: await r.json().catch(() => null) }; };
const logs = () => execSync("docker logs huddletest-app-1 2>&1").toString();
const lastCode = (email) => { const m = [...logs().matchAll(new RegExp(`\\[mail-dev\\] to=${email.replace(/[.+]/g, "\\$&")}[^\\n]*\\nYour Huddle sign-in code is (\\d{6})`, "g"))]; return m.at(-1)?.[1]; };
const lastInvite = (email) => { const m = [...logs().matchAll(new RegExp(`\\[mail-dev\\] to=${email.replace(/[.+]/g, "\\$&")}[\\s\\S]*?#invite=([\\w.-]+)`, "g"))]; return m.at(-1)?.[1]; };
async function signIn(email) {
  await people(null, { action: "request_code", email });
  await new Promise((r) => setTimeout(r, 300));
  return (await people(null, { action: "verify_code", email, code: lastCode(email) })).token;
}
const mcp = async (q, t) => (await (await fetch(`${BASE}/mcp?${q}`, { method: "POST", headers: { ...hdr(t), accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_brief", arguments: {} } }) })).text());
function wsJoin(token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:8130/realtime/v1/websocket?apikey=${ANON}&vsn=1.0.0`);
    ws.onopen = () => ws.send(JSON.stringify({ topic: `realtime:room-${ROOM}`, event: "phx_join", ref: "1", join_ref: "1", payload: { config: { broadcast: { self: false }, presence: { key: "x" } }, access_token: token || ANON } }));
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.event === "phx_reply") { ws.close(); resolve(d.payload?.status); } };
    ws.onerror = () => resolve("error");
    setTimeout(() => resolve("timeout"), 4000);
  });
}

// --- a public room with a note and a file
await rest(null, "rooms", { method: "POST", body: JSON.stringify({ id: ROOM, name: "Secret plans" }) });
await rest(null, "events", { method: "POST", body: JSON.stringify({ room_id: ROOM, author: "zain", kind: "note", text: "secret note" }) });
const up = await fetch(`${BASE}/storage/v1/object/board/${ROOM}/files/a.txt`, { method: "POST", headers: { authorization: `Bearer ${ANON}`, "content-type": "text/plain" }, body: "hello" });
check("public room: anyone can upload", up.ok);
const fileUrl = `${BASE}/storage/v1/object/public/board/${ROOM}/files/a.txt`;

// --- owner signs in, makes it private with Sam on the list
const owner = await signIn("owner@example.com");
check("owner gets a sign-in from the emailed code", !!owner);
const prep = await people(owner, { action: "prepare_private", room: ROOM });
const mp = await people(owner, { action: "make_private", room: ROOM, emails: "sam@example.com, not-an-email", notify: false });
check("make private adds valid emails, skips bad ones", mp.visibility === "private" && mp.added?.[0] === "sam@example.com" && mp.skipped?.[0] === "not-an-email");

// --- outsiders: anonymous and a signed-in stranger
const stranger = await signIn("stranger@example.com");
for (const [who, t] of [["anonymous", null], ["stranger", stranger]]) {
  const ev = await rest(t, `events?room_id=eq.${ROOM}&select=text`);
  check(`${who}: can't read notes`, Array.isArray(ev.body) && ev.body.length === 0, JSON.stringify(ev.body));
  const ins = await rest(t, "events", { method: "POST", body: JSON.stringify({ room_id: ROOM, author: "x", kind: "note", text: "spam" }) });
  check(`${who}: can't post notes`, ins.status >= 400, String(ins.status));
  const rm = await rest(t, `rooms?id=eq.${ROOM}&select=id`);
  check(`${who}: can't see the room row`, Array.isArray(rm.body) && rm.body.length === 0);
  check(`${who}: can't call room functions`, (await fnCall(t, "forget", { room: ROOM, author: "zain" })) === 403);
  check(`${who}: can't call brain-api`, (await fnCall(t, "brain-api", { room: ROOM, author: "x", text: "hi" })) === 403);
  check(`${who}: can't open the file`, (await fetch(fileUrl)).status === 403);
  const up2 = await fetch(`${BASE}/storage/v1/object/board/${ROOM}/files/b.txt`, { method: "POST", headers: { authorization: `Bearer ${t || ANON}`, "content-type": "text/plain" }, body: "x" });
  check(`${who}: can't upload`, up2.status === 403, String(up2.status));
  check(`${who}: can't join live updates`, (await wsJoin(t)) !== "ok");
  check(`${who}: can't read via AI without a key`, /private/i.test(await mcp(`room=${ROOM}`, t)));
  const link = await fetch(`${BASE}/mcp/links`, { method: "POST", headers: hdr(t), body: JSON.stringify({ room: ROOM }) });
  check(`${who}: can't make an AI link`, link.status === 403);
  const st = await people(t, { action: "status", room: ROOM });
  check(`${who}: status reveals no people or file key`, st.can_see === false && !st.people && !st.file_key);
  check(`${who}: can't invite`, (await people(t, { action: "invite", room: ROOM, emails: "x@example.com" })).status === 403);
  check(`${who}: can't delete the room`, (await fnCall(t, "delete-room", { room: ROOM, confirm: ROOM })) === 403);
}

// --- owner: file opens with the key, status has the list
const ost = await people(owner, { action: "status", room: ROOM });
check("owner status: owner, list of 2", ost.is_owner && ost.people?.length === 2);
check("file opens with the room's file key", (await fetch(`${fileUrl}?k=${ost.file_key}`)).status === 200);
check("wrong file key refused", (await fetch(`${fileUrl}?k=nope`)).status === 403);

// --- Sam signs in and gets in
const sam = await signIn("sam@example.com");
const sev = await rest(sam, `events?room_id=eq.${ROOM}&select=text`);
check("Sam can read notes", sev.body?.length >= 1);
check("Sam can join live updates", (await wsJoin(sam)) === "ok");
check("Sam isn't owner", (await people(sam, { action: "invite", room: ROOM, emails: "z@example.com" })).status === 403);
check("Sam can't delete the room", (await fnCall(sam, "delete-room", { room: ROOM, confirm: ROOM })) === 403);
const lk = await (await fetch(`${BASE}/mcp/links`, { method: "POST", headers: hdr(sam), body: JSON.stringify({ room: ROOM, label: "Claude" }) })).json();
check("Sam can connect an AI", !!lk.key);
check("Sam's AI can read the brief", /Huddle brief/.test(await mcp(`room=${ROOM}&key=${lk.key}`)));
const ost2 = await people(owner, { action: "status", room: ROOM });
check("owner sees Sam's AI", ost2.people?.find((p) => p.email === "sam@example.com")?.ais?.length === 1);

// --- owner removes Sam: Sam and Sam's AI are out
await people(owner, { action: "remove", room: ROOM, email: "sam@example.com" });
check("removed: Sam can't read", (await rest(sam, `events?room_id=eq.${ROOM}&select=text`)).body?.length === 0);
check("removed: Sam's AI is turned off", !/Huddle brief/.test(await mcp(`room=${ROOM}&key=${lk.key}`)));

// --- ask to join
const ask = await people(stranger, { action: "ask", room: ROOM, name: "Stan" });
check("stranger can ask", ask.status === "pending");
const ost3 = await people(owner, { action: "status", room: ROOM });
check("owner sees the request", ost3.requests?.[0]?.email === "stranger@example.com");
check("stranger can't decide their own request", (await people(stranger, { action: "decide", room: ROOM, id: ost3.requests[0].id, admit: true })).status === 403);
await people(owner, { action: "decide", room: ROOM, id: ost3.requests[0].id, admit: true });
check("admitted: stranger can read now", (await rest(stranger, `events?room_id=eq.${ROOM}&select=text`)).body?.length >= 1);
check("admitted: request status says so", (await people(stranger, { action: "request_status", room: ROOM })).status === "admitted");

// --- invite link signs you in
await people(owner, { action: "invite", room: ROOM, emails: "new@example.com" });
await new Promise((r) => setTimeout(r, 300));
const inv = lastInvite("new@example.com");
const red = await people(null, { action: "redeem_invite", invite: inv });
check("invite link signs the invitee in", red.email === "new@example.com" && !!red.token);
check("invitee can read", (await rest(red.token, `events?room_id=eq.${ROOM}&select=text`)).body?.length >= 1);
check("tampered invite refused", (await people(null, { action: "redeem_invite", invite: inv.slice(0, -2) + "xx" })).status === 400);

// --- guest pass from the switch
const g = await people(null, { action: "stay", stay: prep.stay });
check("stay pass gives a guest who can read", (await rest(g.token, `events?room_id=eq.${ROOM}&select=text`)).body?.length >= 1);
const other = `${ROOM}x`;
await rest(null, "rooms", { method: "POST", body: JSON.stringify({ id: other }) });
await people(owner, { action: "make_private", room: other, emails: "" });
check("guest pass is for that room only", (await rest(g.token, `rooms?id=eq.${other}&select=id`)).body?.length === 0);

// --- code guessing
await people(null, { action: "request_code", email: "guess@example.com" });
let last;
for (let i = 0; i < 6; i++) last = await people(null, { action: "verify_code", email: "guess@example.com", code: "000000" });
check("too many wrong codes stops guessing", last.status === 429 && last.expired);
const again = await people(null, { action: "request_code", email: "guess@example.com" });
check("asking again within 30s is refused", again.status === 429);

// --- owner deletes
check("owner can delete", (await fnCall(owner, "delete-room", { room: ROOM, confirm: ROOM })) === 200);
check("people list is gone too", execSync(`docker exec huddletest-db-1 psql -U postgres -d huddle -tAc "select count(*) from room_people where room_id='${ROOM}'"`).toString().trim() === "0");

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
