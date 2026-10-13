import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { marked } from "https://esm.sh/marked@12.0.2";
import DOMPurify from "https://esm.sh/dompurify@3.1.6";
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const $ = (id) => document.getElementById(id);
const FN_BASE = `${SUPABASE_URL}/functions/v1`;

// Small DOM helper: h("div", { class: "x", onclick }, child, "text", …)
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return el;
}
const svgIcon = (d, size = 15) => {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("width", size); s.setAttribute("height", size); s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("fill", "none"); s.setAttribute("stroke", "currentColor"); s.setAttribute("stroke-width", "2");
  s.setAttribute("stroke-linecap", "round"); s.setAttribute("stroke-linejoin", "round"); s.setAttribute("aria-hidden", "true");
  s.innerHTML = d;
  return s;
};

// ---------- identity & room ----------
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
  json(k, fallback) { try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; } },
};
const url = new URL(location.href);
let room = url.searchParams.get("room");
if (!room) {
  room = Math.random().toString(36).slice(2, 8);
  url.searchParams.set("room", room);
  history.replaceState(null, "", url);
}
const clientId = crypto.randomUUID();
let me = store.get("huddle:name") || "";

// Rooms you've been in live in this browser only (no accounts yet).
const myRooms = store.json("huddle:rooms", []);
if (!myRooms.find((r) => r.id === room)) myRooms.unshift({ id: room, name: "" });
store.set("huddle:rooms", JSON.stringify(myRooms.slice(0, 20)));
const roomLabel = (id) => myRooms.find((r) => r.id === id)?.name || `Room ${id}`;
$("roomName").textContent = roomLabel(room);
$("roomCode").textContent = room;
document.title = `${roomLabel(room)} · Huddle`;

const COLORS = ["#1D4ED8", "#0E7490", "#6D28D9", "#B45309", "#BE185D", "#15803D", "#B42318"];
const colorFor = (name) => {
  let hh = 0;
  for (const c of name || "?") hh = (hh * 31 + c.charCodeAt(0)) >>> 0;
  return name === "huddle" ? "#244D3C" : COLORS[hh % COLORS.length];
};
const md = (s) => DOMPurify.sanitize(marked.parse(s || ""));
const plain = (s) => (s || "").replace(/[#*_>`\[\]]/g, "").replace(/\s+/g, " ").trim();
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const timeAgo = (iso) => {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return clock(iso);
};
const isMobile = () => matchMedia("(max-width: 900px)").matches;

function toast(msg, ms = 2800) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}

async function fn(name, body) {
  const { data, error } = await sb.functions.invoke(name, { body });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data;
}

// ---------- state ----------
const state = { events: new Map(), jobs: new Map(), pipelines: new Map(), brain: null, peers: [], room: null };
const ui = {
  filter: "all", showAll: false, thread: null, view: "brief", tab: "brief", focus: false,
  openGroups: new Set(), openJobs: new Set(), doneOpen: false,
};
let renderQueued = false;
function renderAll() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderStream(); renderBrain(); renderBoardGallery(); renderWork(); renderJoinInfo();
  });
}

// ==========================================================================
// STREAM — people only. Speech clips from one person in a row merge into one paragraph.
// ==========================================================================
const KIND_LABEL = { speech: "said", note: "note", link: "link", image: "image", finding: "finding", feedback: "feedback" };
const FILTERS = { voice: ["speech"], text: ["note", "link", "finding", "feedback"], media: ["image"] };
const STREAM_LIMIT = 30;
const idToGroup = new Map();

function groupEvents() {
  const evs = [...state.events.values()].filter((e) => e.kind !== "system").sort((a, b) => a.id - b.id);
  const groups = [];
  for (const e of evs) {
    const last = groups[groups.length - 1];
    if (e.kind === "speech" && last && last.kind === "speech" && last.author === e.author &&
        new Date(e.created_at) - new Date(last.lastAt) < 90_000) {
      last.ids.push(e.id); last.lines.push(e.text || ""); last.lastAt = e.created_at;
    } else {
      groups.push({ key: e.id, kind: e.kind, author: e.author, ids: [e.id], lines: [e.text || ""], e, at: e.created_at, lastAt: e.created_at });
    }
  }
  return groups;
}

function renderStream() {
  const list = $("events");
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  const all = groupEvents();
  const allowed = FILTERS[ui.filter];
  const filtered = allowed ? all.filter((g) => allowed.includes(g.kind)) : all;
  const hidden = ui.showAll || ui.thread ? 0 : Math.max(0, filtered.length - STREAM_LIMIT);
  const shown = filtered.slice(hidden);
  const refs = ui.thread?.refs;

  idToGroup.clear();
  list.innerHTML = "";
  if (hidden) list.append(h("button", { class: "earlier", onclick: () => { ui.showAll = true; renderStream(); } }, `Show ${hidden} earlier`));
  if (!shown.length) {
    list.append(h("p", { class: "empty" }, state.events.size
      ? "Nothing here for this filter."
      : "Nothing yet. Talk, type or drop anything in. Huddle will make sense of it."));
  }
  for (const g of shown) {
    g.ids.forEach((id) => idToGroup.set(id, g.key));
    const hit = refs && g.ids.some((id) => refs.has(id));
    const cls = ["ev", g.kind === "speech" ? "speech" : "", hit ? "hl" : refs ? "dim" : ""].join(" ");
    const range = g.ids.length > 1 ? `#${g.ids[0]}–${g.ids[g.ids.length - 1]}` : `#${g.ids[0]}`;
    const head = h("div", { class: "evh" },
      h("span", { class: "av", style: `background:${colorFor(g.author)}` }, (g.author || "?").slice(0, 1).toUpperCase()),
      h("span", { class: "who" }, g.author),
      h("span", { class: "kind" }, KIND_LABEL[g.kind] || g.kind),
      h("span", { class: "meta" }, `${range} · ${clock(g.at)}`));
    const el = h("div", { class: cls, id: `ev-${g.key}` }, head);
    const open = ui.openGroups.has(g.key);
    const toggle = (label) => h("button", { class: "link", onclick: () => { open ? ui.openGroups.delete(g.key) : ui.openGroups.add(g.key); renderStream(); } }, label);

    if (g.kind === "speech") {
      el.append(h("div", { class: "evb" }, g.lines.join(" ")));
      if (g.ids.length > 1) {
        el.append(h("div", { class: "evlinks" }, toggle(open ? "Hide clips" : `Show ${g.ids.length} clips`)));
        if (open) el.append(h("div", { class: "raw" }, g.lines.join("\n")));
      }
    } else if (g.kind === "image") {
      const card = h("div", { class: "cardin" });
      if (g.e.image_url) card.append(h("img", { src: g.e.image_url, alt: "Shared image", loading: "lazy", onclick: () => window.open(g.e.image_url, "_blank") }));
      if (g.e.text) {
        card.append(h("div", {}, toggle(open ? "Hide" : "What Huddle saw")));
        if (open) card.append(h("div", { class: "saw", html: md(g.e.text) }));
      }
      el.append(card);
    } else if (g.kind === "link") {
      const href = (g.e.text || "").trim();
      el.append(h("div", { class: "evb" }, h("a", { href, target: "_blank", rel: "noopener" }, href)));
    } else {
      const text = g.e.text || "";
      const long = text.length > 280;
      const body = h("div", { class: `evb${long && !open ? " clamp" : ""}` });
      if (g.kind === "finding" || g.kind === "feedback") body.innerHTML = md(text); else body.textContent = text;
      el.append(body);
      if (long) el.append(h("div", { class: "evlinks" }, toggle(open ? "Show less" : "Show more")));
    }
    list.append(el);
  }
  if (ui.thread) {
    const first = list.querySelector(".ev.hl");
    if (first) first.scrollIntoView({ block: "center" });
  } else if (atBottom) list.scrollTop = list.scrollHeight;
  $("streamRailCount").textContent = all.length;
}

document.querySelectorAll("#filters button").forEach((b) => (b.onclick = () => {
  ui.filter = b.dataset.filter;
  document.querySelectorAll("#filters button").forEach((x) => x.classList.toggle("on", x === b));
  renderStream();
}));

function jumpTo(id) {
  const key = idToGroup.get(id);
  if (key == null && !ui.showAll) { ui.showAll = true; renderStream(); }
  const el = $(`ev-${idToGroup.get(id)}`);
  if (!el) return toast(`#${id} is older than what's loaded`);
  if (isMobile()) setTab("stream");
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("flash");
  setTimeout(() => el.classList.remove("flash"), 1600);
}

// ==========================================================================
// BRIEF
// ==========================================================================
function setThread(item, label) {
  const refs = new Set((item?.refs || []).map(Number));
  if (!item || !refs.size || ui.thread?.item?.text === item.text) ui.thread = null;
  else ui.thread = { item, refs, label };
  renderStream(); renderBrain();
  $("threadBar").hidden = !ui.thread;
  if (ui.thread) {
    $("threadLabel").textContent = `${label} — sources ${[...refs].map((r) => `#${r}`).join(" ")} are highlighted in the stream.`;
    if (isMobile()) setTab("stream");
  }
}
$("clearThread").onclick = () => setThread(null);

function renderBrain() {
  const b = state.brain;
  const s = b?.state || {};
  $("brainMeta").textContent = b?.updated_at ? `Updated ${timeAgo(b.updated_at)}` : "";
  $("bGoal").textContent = s.goal || "No goal yet. Talk it through and Huddle will write one here.";
  $("bGoal").classList.toggle("empty-goal", !s.goal);
  $("bSummary").textContent = s.summary || "";
  $("nowBox").hidden = !s.summary;
  const ch = $("bChanged");
  ch.innerHTML = "";
  (s.changed || []).slice(0, 4).forEach((c) => ch.append(h("span", { class: "chg" }, h("span", { class: "newmark" }, "NEW"), c)));

  const fill = (id, items = [], emptyText, label, withType) => {
    const box = $(id);
    box.innerHTML = "";
    if (!items.length) box.append(h("p", { class: "empty" }, emptyText));
    for (const it of items) {
      const sel = ui.thread?.item?.text === it.text;
      const refs = h("span", { class: "refs" }, it.owner || it.by || "", ...(it.refs || []).slice(0, 4).map((r) => h("span", { class: "ref" }, `#${r}`)));
      box.append(h("div", { class: `item${sel ? " sel" : ""}` },
        withType ? h("span", { class: `tb ${it.type || "todo"}` }, it.type || "todo") : null,
        h("button", { class: "ibody", onclick: () => setThread(it, label) }, h("span", { class: "itext" }, it.text), refs)));
    }
  };
  fill("bDecisions", s.decisions, "Nothing decided yet. Huddle adds decisions as you make them.", "Decision");
  fill("bQuestions", s.questions, "Nothing open yet.", "Open question");
  fill("bIdeas", s.ideas, "Ideas will show up as you talk.", "Idea");
  fill("bNext", s.next_steps, "Next steps appear here, with an owner. Huddle can pick some up itself.", "Next step", true);
  $("nDec").textContent = (s.decisions || []).length;
  $("nQ").textContent = (s.questions || []).length;
  $("nIdeas").textContent = (s.ideas || []).length;

  const made = doneJobs();
  $("nMade").textContent = made.length;
  const gal = $("made");
  gal.innerHTML = "";
  if (!made.length) gal.append(h("p", { class: "empty" }, "Research, prototypes and anything else your agents make will collect here."));
  for (const j of made.slice(0, 12)) {
    const card = h("button", { class: "made", onclick: () => openViewer(j.id) });
    if (j.kind === "prototype" && j.output_html) {
      const f = h("iframe", { class: "thumb", sandbox: "", tabindex: "-1", title: "Prototype preview" });
      f.srcdoc = j.output_html;
      card.append(f);
    }
    card.append(h("span", { class: `kb ${j.kind}` }, j.kind === "prototype" ? "Prototype" : "Research"),
      h("b", {}, j.title), h("small", {}, clip(plain(j.output_md), 120)));
    gal.append(card);
  }
}
setInterval(() => renderBrain(), 30000);

// Things the agents made: single jobs, plus each pipeline's research/prototype outputs (not its review or host steps).
const doneJobs = () => [...state.jobs.values()].filter((j) => {
  if (j.status !== "done") return false;
  if (!j.pipeline_id) return true;
  const stage = state.pipelines.get(j.pipeline_id)?.stages?.[j.stage_index];
  return stage === "research" || stage === "prototype";
}).sort((a, b) => b.id - a.id);

let synthBusy = false;
async function synthesize(force = false) {
  if (synthBusy) return;
  synthBusy = true;
  if (force) $("synthBtn").textContent = "Updating…";
  try {
    const r = await fn("synthesize", { room, force });
    if (force && r?.started) toast(`Huddle started ${r.started} job${r.started > 1 ? "s" : ""}`);
  } catch (e) {
    console.error(e);
    if (force) toast(`Couldn't update the brief: ${e.message}`);
  } finally {
    synthBusy = false;
    $("synthBtn").textContent = "Update now";
  }
}
$("synthBtn").onclick = () => synthesize(true);

// One browser (the "leader", lowest presence id) runs synthesis on a timer so we don't triple-bill.
setInterval(() => {
  const ids = state.peers.map((p) => p.clientId).sort();
  if (me && ids[0] === clientId) synthesize(false);
}, 45000);

// ==========================================================================
// BOARD — live shared strokes (as before) + everything visual shared in the room
// ==========================================================================
function renderBoardGallery() {
  const imgs = [...state.events.values()].filter((e) => e.kind === "image" && e.image_url).sort((a, b) => b.id - a.id);
  $("nBoard").textContent = imgs.length;
  const g = $("boardGallery");
  g.innerHTML = "";
  if (!imgs.length) g.append(h("p", { class: "empty" }, "Sketches, photos and screenshots shared in this huddle show up here."));
  for (const e of imgs) {
    g.append(h("div", { class: "bcard" },
      h("img", { src: e.image_url, alt: "Shared image", loading: "lazy", onclick: () => window.open(e.image_url, "_blank") }),
      h("small", {}, `${e.author} · ${clock(e.created_at)}`)));
  }
}

const canvas = $("board");
const ctx2d = canvas.getContext("2d");
let penColor = "#1E2A22";
let boardDirty = false;
function clearCanvas() {
  ctx2d.fillStyle = "#ffffff";
  ctx2d.fillRect(0, 0, canvas.width, canvas.height);
}
clearCanvas();
function drawStroke(pts, color) {
  if (pts.length < 2) return;
  ctx2d.strokeStyle = color;
  ctx2d.lineWidth = 4;
  ctx2d.lineCap = "round";
  ctx2d.lineJoin = "round";
  ctx2d.beginPath();
  ctx2d.moveTo(pts[0][0], pts[0][1]);
  for (const [x, y] of pts.slice(1)) ctx2d.lineTo(x, y);
  ctx2d.stroke();
  boardDirty = true;
}
let cur = null;
const toCanvas = (ev) => {
  const r = canvas.getBoundingClientRect();
  return [((ev.clientX - r.left) / r.width) * canvas.width, ((ev.clientY - r.top) / r.height) * canvas.height];
};
canvas.addEventListener("pointerdown", (ev) => { canvas.setPointerCapture(ev.pointerId); cur = [toCanvas(ev)]; });
canvas.addEventListener("pointermove", (ev) => {
  if (!cur) return;
  const p = toCanvas(ev);
  drawStroke([cur[cur.length - 1], p], penColor);
  cur.push(p);
});
canvas.addEventListener("pointerup", () => {
  if (cur?.length > 1) roomChannel?.send({ type: "broadcast", event: "stroke", payload: { pts: cur, color: penColor } });
  cur = null;
});
document.querySelectorAll(".swatch").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll(".swatch").forEach((x) => x.classList.remove("on"));
    b.classList.add("on");
    penColor = b.dataset.color;
  };
});
$("clearBoard").onclick = () => {
  clearCanvas();
  boardDirty = false;
  roomChannel?.send({ type: "broadcast", event: "clear", payload: {} });
};
$("shareBoard").onclick = () => {
  if (!boardDirty) return toast("Draw something first");
  canvas.toBlob((blob) => blob && shareImage(blob, "whiteboard sketch"), "image/png");
  toast("Sent. Huddle will read it into the brief.");
};

// ==========================================================================
// WORK — mode, ask, needs the room, suggestions, running, done
// ==========================================================================
const MODE_DESC = {
  suggest: "Huddle proposes jobs. Nothing runs until someone presses start.",
  auto: "Huddle runs research and builds on its own, and asks the room before it publishes anything or spends more.",
  full: "Huddle runs and publishes on its own. Use when you trust the brief.",
};
async function pipeAct(id, action, answer) {
  try { await fn("orchestrate", { pipeline_id: id, action, answer }); }
  catch (e) { toast(`Couldn't ${action}: ${e.message}`); }
}
async function runJob(id) {
  try { await fn("run-job", { job_id: id }); }
  catch (e) { toast(`Could not start job: ${e.message}`); }
}
const jobsOf = (pid) => [...state.jobs.values()].filter((j) => j.pipeline_id === pid);
const pipeType = (p) => (p.stages.includes("prototype") ? "build" : "research");

function stageChips(p) {
  const js = jobsOf(p.id);
  const row = h("div", { class: "stages" });
  p.stages.forEach((name, i) => {
    const mine = js.filter((j) => j.stage_index === i);
    const last = mine[mine.length - 1];
    let cls = "sg";
    if (p.status === "waiting" && p.gate && p.gate.stage === i) cls += " gate";
    else if (last?.status === "running" || last?.status === "proposed") cls += state.room?.paused ? " paused" : " run";
    else if (last?.status === "done") cls += " done";
    else if (last?.status === "failed") cls += " failed";
    const label = name === "review" && last?.review ? `review ${last.review.score}/10` : name;
    const chip = h("span", { class: cls, title: last?.status === "failed" ? last.error || "failed" : last?.status === "done" ? "Open output" : null },
      cls.includes(" run") ? h("span", { class: "spinner" }) : null, label);
    if (last?.status === "done") chip.onclick = () => openViewer(last.id);
    row.append(chip);
  });
  return row;
}
function stepText(p) {
  const js = jobsOf(p.id);
  let at = 0;
  p.stages.forEach((_, i) => { if (js.some((j) => j.stage_index === i)) at = i; });
  return `${state.room?.paused ? "Paused · " : ""}Step ${at + 1} of ${p.stages.length} · ${p.stages[at]}`;
}

function renderWork() {
  const r = state.room;
  const mode = r?.mode || "auto";
  document.querySelectorAll("#modeSeg button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  $("modeDesc").textContent = MODE_DESC[mode];
  $("stopAll").textContent = r?.paused ? "Resume all agents" : "Stop all agents";

  const pipes = [...state.pipelines.values()];
  const singles = [...state.jobs.values()].filter((j) => !j.pipeline_id && j.status !== "dismissed");
  const thread = ui.thread?.refs;

  // Needs the room
  const waiting = pipes.filter((p) => p.status === "waiting" && p.gate).sort((a, b) => a.id - b.id);
  const gates = $("gates");
  gates.innerHTML = "";
  for (const p of waiting) {
    const hit = thread && p.origin_event_id && thread.has(Number(p.origin_event_id));
    const card = h("div", { class: `gate${hit ? " hl" : ""}` },
      h("div", { class: "gtop" }, h("span", { class: `tb ${pipeType(p)}` }, pipeType(p)), h("span", {}, p.title)),
      stageChips(p),
      h("p", { class: "gq" }, p.gate.question));
    const row = h("div", { class: "crow" });
    if (p.gate.kind === "question") {
      const inp = h("input", { class: "inp", placeholder: "Type an answer", "aria-label": "Your answer" });
      const send = () => inp.value.trim() && pipeAct(p.id, "approve", inp.value.trim());
      inp.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); send(); } });
      row.append(inp, h("button", { class: "btn amber sm", onclick: send }, "Answer"),
        h("button", { class: "btn ghost sm", onclick: () => pipeAct(p.id, "skip") }, "Use your judgment"));
      card.append(row, h("p", { class: "hint" }, "Or just answer out loud. Huddle will match it to this question."));
    } else if (p.gate.kind === "publish") {
      const out = jobsOf(p.id).filter((j) => j.status === "done" && j.kind === "prototype").pop();
      row.append(h("button", { class: "btn amber sm", onclick: () => pipeAct(p.id, "approve") }, "Publish"),
        out ? h("button", { class: "btn ghost sm", onclick: () => openViewer(out.id) }, "Preview first") : null,
        h("button", { class: "btn ghost sm", onclick: () => pipeAct(p.id, "skip") }, "Not yet"));
      card.append(row, h("p", { class: "hint" }, "Or just say “yes, publish it.”"));
    } else {
      row.append(h("button", { class: "btn amber sm", onclick: () => pipeAct(p.id, "approve") }, "Continue"),
        h("button", { class: "btn ghost sm", onclick: () => pipeAct(p.id, "stop") }, "Stop"));
      card.append(row);
    }
    gates.append(card);
  }
  $("needsWrap").hidden = !waiting.length;
  $("nNeeds").textContent = waiting.length;

  // Huddle suggests (proposed pipelines and single jobs)
  const sugg = $("sugg");
  sugg.innerHTML = "";
  const proposedPipes = pipes.filter((p) => p.status === "proposed");
  const proposedJobs = singles.filter((j) => j.status === "proposed");
  for (const p of proposedPipes) {
    sugg.append(h("div", { class: "sugg" }, h("b", {}, p.title), h("span", { class: "muted small" }, p.stages.join(" → ")),
      h("div", { class: "crow" }, h("button", { class: "btn pri sm", onclick: () => pipeAct(p.id, "start") }, "Start"),
        h("button", { class: "btn ghost sm", onclick: () => pipeAct(p.id, "stop") }, "Not now"))));
  }
  for (const j of proposedJobs) {
    sugg.append(h("div", { class: "sugg" }, h("b", {}, j.title), h("span", { class: "muted small" }, clip(plain(j.prompt), 140)),
      h("div", { class: "crow" }, h("button", { class: "btn pri sm", onclick: () => runJob(j.id) }, "Run it"),
        h("button", { class: "btn ghost sm", onclick: () => sb.from("jobs").update({ status: "dismissed" }).eq("id", j.id) }, "Not now"))));
  }
  $("suggWrap").hidden = !(proposedPipes.length + proposedJobs.length);

  // Running
  const run = $("running");
  run.innerHTML = "";
  const runningPipes = pipes.filter((p) => p.status === "running").sort((a, b) => b.id - a.id);
  const runningJobs = singles.filter((j) => j.status === "running").sort((a, b) => b.id - a.id);
  for (const p of runningPipes) {
    const key = `p${p.id}`;
    const open = ui.openJobs.has(key);
    const hit = thread && p.origin_event_id && thread.has(Number(p.origin_event_id));
    run.append(h("button", { class: `jrow${hit ? " hl" : ""}`, "aria-expanded": String(open), onclick: () => { open ? ui.openJobs.delete(key) : ui.openJobs.add(key); renderWork(); } },
      h("span", { class: `tb ${pipeType(p)}` }, pipeType(p)),
      h("span", { class: "grow" }, h("b", {}, p.title), h("small", {}, stepText(p)))));
    if (open) {
      run.append(h("div", { class: "jdet" }, stageChips(p),
        h("div", { class: "crow" }, h("span", { class: "muted small grow" }, `#${p.id} · ${p.created_by}`),
          h("button", { class: "btn ghost sm", onclick: () => pipeAct(p.id, "stop") }, "Stop"))));
    }
  }
  for (const j of runningJobs) {
    run.append(h("div", { class: "jrow" }, h("span", { class: `tb ${j.kind}` }, j.kind),
      h("span", { class: "grow" }, h("b", {}, j.title), h("small", {}, state.room?.paused ? "Paused" : "Working…")),
      state.room?.paused ? null : h("span", { class: "spinner", style: "color:#244D3C" })));
  }
  const nRun = runningPipes.length + runningJobs.length;
  if (!nRun) run.append(h("p", { class: "empty" }, "Nothing running. Ask above, or just say “Huddle, research…”"));
  $("nRun").textContent = nRun;

  // Done
  const doneList = [
    ...pipes.filter((p) => ["done", "failed", "stopped"].includes(p.status)).map((p) => ({ id: p.id, p, at: p.id * 1e6 })),
    ...singles.filter((j) => ["done", "failed"].includes(j.status)).map((j) => ({ id: j.id, j, at: j.id * 1e6 })),
  ];
  const done = $("done");
  done.innerHTML = "";
  for (const d of doneList.sort((a, b) => b.at - a.at)) {
    if (d.p) {
      const p = d.p;
      const lastOut = jobsOf(p.id).filter((j) => j.status === "done").pop();
      const failed = p.status !== "done";
      done.append(h("button", { class: "drow", onclick: () => (failed ? pipeAct(p.id, "start") : lastOut && openViewer(lastOut.id)) },
        h("span", { class: `dot${failed ? " failed" : ""}` }), h("span", { class: "grow" }, p.title),
        p.host_url ? h("a", { class: "live-link", href: p.host_url, target: "_blank", rel: "noopener", onclick: (ev) => ev.stopPropagation() }, "Live ↗")
          : h("span", { class: "muted small" }, failed ? `${p.status} · restart` : pipeType(p))));
    } else {
      const j = d.j;
      const failed = j.status === "failed";
      done.append(h("button", { class: "drow", onclick: () => (failed ? runJob(j.id) : openViewer(j.id)) },
        h("span", { class: `dot${failed ? " failed" : ""}` }), h("span", { class: "grow" }, j.title),
        h("span", { class: "muted small" }, failed ? "failed · retry" : j.kind)));
    }
  }
  $("nDone").textContent = doneList.length;
  $("done").hidden = !ui.doneOpen;
  $("doneToggleLabel").textContent = ui.doneOpen ? "Hide" : "Show";
  $("doneToggle").setAttribute("aria-expanded", String(ui.doneOpen));

  // Counts that show elsewhere
  $("workSub").textContent = `${nRun} running${waiting.length ? ` · ${waiting.length} waiting on you` : ""}`;
  $("needPill").hidden = !waiting.length;
  $("needPill").textContent = `${waiting.length} ${waiting.length === 1 ? "thing needs" : "things need"} the room`;
  $("mBadge").hidden = !waiting.length;
  $("mBadge").textContent = waiting.length;
  $("workRailCount").textContent = nRun;
  $("workRailNeeds").hidden = !waiting.length;
  $("workRailNeeds").textContent = waiting.length;
}
$("doneToggle").onclick = () => { ui.doneOpen = !ui.doneOpen; renderWork(); };
$("needPill").onclick = (ev) => { ev.preventDefault(); if (ui.focus) setFocus(false); $("needs").scrollIntoView({ behavior: "smooth" }); };

document.querySelectorAll("#modeSeg button").forEach((b) => (b.onclick = async () => {
  const mode = b.dataset.mode;
  const { error } = await sb.from("rooms").update({ mode }).eq("id", room);
  if (error) return toast(error.message);
  if (state.room) state.room.mode = mode;
  renderWork();
}));
$("stopAll").onclick = async () => {
  const paused = state.room?.paused;
  try { await fn("orchestrate", { room, action: paused ? "resume" : "stop_all" }); toast(paused ? "Agents resumed." : "All agents paused. Nothing runs until you resume."); }
  catch (e) { toast(e.message); }
};

async function ask() {
  const text = $("jobPrompt").value.trim();
  if (!text) return toast("Type what you want, or just say “Huddle, research…”");
  const kind = /\b(build|prototype|make|design|mock ?up|app|page)\b/i.test(text) ? "prototype" : "research";
  $("jobPrompt").value = "";
  const { data, error } = await sb.from("jobs")
    .insert({ room_id: room, kind, title: text.slice(0, 90), prompt: text, created_by: me, status: "proposed" })
    .select().single();
  if (error) return toast(error.message);
  runJob(data.id);
  toast(`Started: ${clip(text, 60)}`);
}
$("askBtn").onclick = ask;
$("jobPrompt").addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); ask(); } });

// ---------- output viewer ----------
let viewing = null;
let blobUrl = null;
function openViewer(id) {
  const j = state.jobs.get(id);
  if (!j) return;
  viewing = id;
  $("vKind").textContent = j.kind === "prototype" ? "Prototype" : "Research";
  $("vKind").className = `kb ${j.kind}`;
  $("vTitle").textContent = j.title;
  const body = $("vBody");
  body.innerHTML = "";
  if (blobUrl) URL.revokeObjectURL(blobUrl);
  blobUrl = null;
  if (j.kind === "prototype") {
    const frame = h("iframe", { class: "proto", sandbox: "allow-scripts allow-forms allow-modals", title: j.title });
    frame.srcdoc = j.output_html || "";
    body.append(frame);
    if (j.output_md) body.append(h("p", { class: "muted small" }, j.output_md));
    blobUrl = URL.createObjectURL(new Blob([j.output_html || ""], { type: "text/html" }));
    $("vOpen").hidden = false;
  } else {
    body.append(h("article", { class: "prose", html: md(j.output_md) }));
    if (j.sources?.length) {
      body.append(h("h4", {}, "Sources"), h("ul", { class: "sources" },
        ...j.sources.map((s) => h("li", {}, h("a", { href: s.url, target: "_blank", rel: "noopener" }, s.title)))));
    }
    $("vOpen").hidden = true;
  }
  $("vFeedback").hidden = !["research", "prototype"].includes(j.kind);
  $("viewer").hidden = false;
}
$("vOpen").onclick = () => blobUrl && window.open(blobUrl, "_blank");
$("vClose").onclick = () => ($("viewer").hidden = true);
async function revise() {
  const text = $("vFeedbackInput").value.trim();
  const parent = state.jobs.get(viewing);
  if (!text) return toast("Say what to change, e.g. “compare three tools”.");
  if (!parent) return;
  $("vFeedbackInput").value = "";
  const n = (parent.title.match(/\(v(\d+)\)$/)?.[1] | 0 || 1) + 1;
  const baseTitle = parent.title.replace(/\s*\(v\d+\)$/, "");
  const { data, error } = await sb.from("jobs").insert({
    room_id: room, kind: parent.kind, title: `${baseTitle} (v${n})`, prompt: `Feedback from ${me}: ${text}`,
    parent_id: parent.id, created_by: me, status: "proposed",
  }).select().single();
  if (error) return toast(error.message);
  await sb.from("events").insert({ room_id: room, author: me, kind: "feedback", text: `On "${baseTitle}": ${text}` });
  runJob(data.id);
  $("viewer").hidden = true;
  toast(`Making v${n}. Watch it in Work.`);
}
$("vRevise").onclick = revise;
$("vFeedbackInput").addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); revise(); } });

// ==========================================================================
// SHARING INTO THE ROOM: notes, links, images (desktop composer + phone capture bar)
// ==========================================================================
async function postNote(text) {
  if (!me) return toast("Join the huddle first");
  const kind = /^https?:\/\/\S+$/.test(text) ? "link" : "note";
  const { data, error } = await sb.from("events").insert({ room_id: room, author: me, kind, text }).select().single();
  if (error) return toast(error.message);
  if (kind === "note") fn("intake", { room, author: me, text, event_id: data.id }).catch(() => {});
}
function sendFrom(input) {
  const t = input.value.trim();
  if (!t) return;
  input.value = "";
  postNote(t);
}
$("sendBtn").onclick = () => sendFrom($("noteInput"));
$("noteInput").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); sendFrom($("noteInput")); }
});
$("mNote").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") { ev.preventDefault(); sendFrom($("mNote")); }
});

async function shareImage(blob, caption = "") {
  if (!me) return toast("Join the huddle first");
  $("sendStatus").textContent = "Reading image…";
  toast("Sharing your image. Huddle is reading it…");
  try {
    const ext = (blob.type.split("/")[1] || "png").replace("jpeg", "jpg");
    const path = `${room}/${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
    const up = await sb.storage.from("board").upload(path, blob, { contentType: blob.type || "image/png" });
    if (up.error) throw up.error;
    const { data } = sb.storage.from("board").getPublicUrl(path);
    await fn("see", { room, author: me, image_url: data.publicUrl, caption });
  } catch (e) {
    toast(`Image failed: ${e.message}`);
  } finally {
    $("sendStatus").textContent = "";
  }
}
$("fileInput").onchange = (ev) => {
  const f = ev.target.files?.[0];
  if (f) shareImage(f, $("noteInput").value.trim());
  ev.target.value = "";
};
document.querySelectorAll(".shareFile").forEach((inp) => (inp.onchange = (ev) => {
  const f = ev.target.files?.[0];
  if (f) shareImage(f, $("mNote").value.trim());
  ev.target.value = "";
  $("shareSheet").hidden = true;
}));
document.querySelectorAll("[data-share]").forEach((b) => (b.onclick = () => {
  $("shareSheet").hidden = true;
  const kind = b.dataset.share;
  if (kind === "sketch") return setTab("board");
  $("mNote").placeholder = kind === "link" ? "Paste a link…" : "Type a note…";
  $("mNote").focus();
}));
$("plusBtn").onclick = () => ($("shareSheet").hidden = false);
$("sketchBtn").onclick = () => setView("board");

document.addEventListener("paste", (ev) => {
  const item = [...(ev.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
  if (!item) return;
  ev.preventDefault();
  shareImage(item.getAsFile(), $("noteInput").value.trim());
});
// Drop images anywhere on the room
let dragDepth = 0;
window.addEventListener("dragenter", (ev) => { if ([...(ev.dataTransfer?.types || [])].includes("Files")) { dragDepth++; document.body.classList.add("dragging"); } });
window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("dragging"); } });
window.addEventListener("dragover", (ev) => ev.preventDefault());
window.addEventListener("drop", (ev) => {
  ev.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dragging");
  const files = [...(ev.dataTransfer?.files || [])];
  const imgs = files.filter((f) => f.type.startsWith("image/"));
  imgs.forEach((f) => shareImage(f));
  if (files.length > imgs.length) toast("For now Huddle can read images. Other file types are coming.");
});

// ==========================================================================
// LAYOUT: Brief/Board tabs, Focus, phone tabs
// ==========================================================================
function setView(view) {
  ui.view = view;
  document.querySelectorAll("#centerTabs button").forEach((x) => x.classList.toggle("on", x.dataset.view === view));
  $("briefView").hidden = view !== "brief";
  $("boardView").hidden = view !== "board";
  $("synthBtn").hidden = view !== "brief";
  $("centerTitle").textContent = view === "board" ? "Board" : "Brief";
  if (isMobile() && ui.tab !== view) setTab(view);
}
document.querySelectorAll("#centerTabs button").forEach((b) => (b.onclick = () => setView(b.dataset.view)));

function setTab(tab) {
  ui.tab = tab;
  document.querySelectorAll("#mobileTabs button").forEach((x) => x.classList.toggle("on", x.dataset.tab === tab));
  $("stream").classList.toggle("mshow", tab === "stream");
  $("center").classList.toggle("mshow", tab === "brief" || tab === "board");
  $("work").classList.toggle("mshow", tab === "work");
  if ((tab === "brief" || tab === "board") && ui.view !== tab) setView(tab);
  if (tab === "stream") { const l = $("events"); l.scrollTop = l.scrollHeight; }
}
document.querySelectorAll("#mobileTabs button").forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
setTab("brief");

function setFocus(on) {
  ui.focus = on;
  $("focusBtn").classList.toggle("on", on);
  $("focusBtn").setAttribute("aria-pressed", String(on));
  for (const [col, rail, body] of [["stream", "streamRail", "streamBody"], ["work", "workRail", "workBody"]]) {
    $(col).classList.toggle("slim", on);
    $(rail).hidden = !on;
    $(body).hidden = on;
  }
}
$("focusBtn").onclick = () => setFocus(!ui.focus);
$("streamRail").onclick = () => setFocus(false);
$("workRail").onclick = () => setFocus(false);

// ==========================================================================
// ROOMS: menu, new huddle, public / private
// ==========================================================================
function renderRoomMenu() {
  const list = $("roomList");
  list.innerHTML = "";
  for (const r of myRooms) {
    const name = r.name || `Room ${r.id}`;
    list.append(h("button", { class: `ritem${r.id === room ? " on" : ""}`, role: "menuitem", onclick: () => {
      if (r.id === room) return ($("roomMenu").hidden = true);
      location.href = `${location.pathname}?room=${encodeURIComponent(r.id)}`;
    } }, h("span", { class: "rdot", "aria-hidden": "true" }, name.slice(0, 1).toUpperCase()),
      h("span", { class: "grow" }, name, h("small", {}, r.id === room ? "You’re here" : "Public"))));
  }
}
$("roomBtn").onclick = (ev) => {
  ev.stopPropagation();
  const m = $("roomMenu");
  m.hidden = !m.hidden;
  $("roomBtn").setAttribute("aria-expanded", String(!m.hidden));
  if (!m.hidden) renderRoomMenu();
};
document.addEventListener("click", (ev) => {
  if (!$("roomMenu").hidden && !$("roomMenu").contains(ev.target)) { $("roomMenu").hidden = true; $("roomBtn").setAttribute("aria-expanded", "false"); }
});
$("newRoomBtn").onclick = () => { $("roomMenu").hidden = true; $("newRoom").hidden = false; $("newName").focus(); };
$("createRoom").onclick = async () => {
  const id = Math.random().toString(36).slice(2, 8);
  const name = $("newName").value.trim().slice(0, 60) || "New huddle";
  const goal = $("newGoal").value.trim();
  myRooms.unshift({ id, name });
  store.set("huddle:rooms", JSON.stringify(myRooms.slice(0, 20)));
  if (goal) store.set(`huddle:goal:${id}`, goal);
  const link = `${location.origin}${location.pathname}?room=${id}`;
  try { await navigator.clipboard.writeText(link); } catch {}
  location.href = link;
};

// Private huddles aren't built yet: the switch explains that and collects interest.
function openUpgrade() {
  $("roomMenu").hidden = true;
  $("upAsk").hidden = false; $("upEmail").hidden = true; $("upDone").hidden = true;
  $("upgrade").hidden = false;
}
$("visSwitch").onclick = openUpgrade;
$("visSwitch2").onclick = openUpgrade;
$("upYes").onclick = () => { $("upAsk").hidden = true; $("upEmail").hidden = false; $("upEmailInput").focus(); };
function notifyMe() {
  const em = $("upEmailInput").value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return toast("Please enter a valid email.");
  // TODO: store in a waitlist table once one exists. Nothing is saved yet.
  $("upDoneEmail").textContent = em;
  $("upEmail").hidden = true; $("upDone").hidden = false;
}
$("upNotify").onclick = notifyMe;
$("upEmailInput").addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); notifyMe(); } });

// ---------- invite + connect your AI ----------
$("shareBtn").onclick = async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    toast("Invite link copied. This huddle is public, so anyone with the link can join.");
  } catch {
    prompt("Copy this link", location.href);
  }
};
function openConnect() {
  const get = `curl "${FN_BASE}/brain-api?room=${room}"`;
  const post = `curl -X POST "${FN_BASE}/brain-api" -H "content-type: application/json" \\\n  -d '{"room":"${room}","author":"${me || "my-claude"}","text":"<finding>"}'`;
  $("curlGet").textContent = get;
  $("curlPost").textContent = post;
  $("aiPrompt").textContent =
    `You are helping my team in a Huddle room.\nBefore you work, read our living brief:\n${get}\n\nWhen you find something useful, post it back to the room as a finding, with sources:\n${post}`;
  $("connect").hidden = false;
}
$("connectBtn").onclick = openConnect;
$("connectBtn2").onclick = openConnect;
$("copyPrompt").onclick = async () => {
  try { await navigator.clipboard.writeText($("aiPrompt").textContent); toast("Prompt copied. Paste it into your Claude."); }
  catch { toast("Couldn't copy. Select the text and copy it."); }
};

document.querySelectorAll("[data-close]").forEach((b) => (b.onclick = () => ($(b.dataset.close).hidden = true)));
document.querySelectorAll(".ov").forEach((o) =>
  o.addEventListener("click", (ev) => { if (ev.target === o && o.id !== "join") o.hidden = true; }));
window.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape") return;
  document.querySelectorAll(".ov").forEach((o) => { if (o.id !== "join") o.hidden = true; });
  $("roomMenu").hidden = true;
});

// ==========================================================================
// MICROPHONE: on-device voice detection, Gemini transcription (unchanged logic)
// ==========================================================================
const mic = { on: false, stream: null, ctx: null, proc: null, frames: [], pre: [], speaking: false,
  silenceMs: 0, speechMs: 0, noise: 0.008, pttDown: false };

function encodeWav(chunks, rate) {
  const len = chunks.reduce((n, c) => n + c.length, 0);
  const buf = new ArrayBuffer(44 + len * 2);
  const v = new DataView(buf);
  const w = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + len * 2, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, len * 2, true);
  let o = 44;
  for (const c of chunks) for (let i = 0; i < c.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, c[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}
function b64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

let inflight = 0;
function setMicLabel() {
  $("micLabel").textContent = !mic.on ? "Talk"
    : inflight ? "Transcribing…"
    : $("micMode").value === "ptt" ? (mic.pttDown ? "Listening…" : "Hold Space")
    : mic.speaking ? "Listening…" : "Mic on";
  for (const b of [$("micBtn"), $("mMicBtn")]) {
    b.classList.toggle("live", mic.on);
    b.setAttribute("aria-pressed", String(mic.on));
  }
  $("mMicBtn").setAttribute("aria-label", mic.on ? "Mute your mic" : "Turn on your mic");
}

async function flush(force = false) {
  const frames = mic.frames;
  const speechMs = mic.speechMs;
  mic.frames = []; mic.speechMs = 0; mic.silenceMs = 0; mic.speaking = false;
  if (!frames.length || (!force && speechMs < 500)) return setMicLabel();
  const wav = encodeWav(frames, mic.ctx.sampleRate);
  inflight++;
  setMicLabel();
  try {
    await fn("transcribe", { room, author: me, audio: b64(wav) });
  } catch (e) {
    toast(`Transcription failed: ${e.message}`);
  } finally {
    inflight--;
    setMicLabel();
  }
}

function onAudio(data) {
  const frame = new Float32Array(data);
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  const rms = Math.sqrt(sum / frame.length);
  $("meterFill").style.width = `${Math.min(100, rms * 900)}%`;
  const dur = (frame.length / mic.ctx.sampleRate) * 1000;

  if ($("micMode").value === "ptt") {
    if (mic.pttDown) { mic.frames.push(frame); mic.speechMs += dur; }
    return;
  }
  const thr = Math.max(0.012, mic.noise * 3);
  if (rms > thr) {
    if (!mic.speaking) { mic.frames.push(...mic.pre); mic.pre = []; }
    mic.speaking = true; mic.silenceMs = 0; mic.speechMs += dur; mic.frames.push(frame);
  } else if (mic.speaking) {
    mic.frames.push(frame); mic.silenceMs += dur;
    if (mic.silenceMs > 1000) flush();
  } else {
    mic.noise = mic.noise * 0.95 + rms * 0.05;
    mic.pre.push(frame);
    if (mic.pre.length > 3) mic.pre.shift();
  }
  if (mic.frames.length && mic.frames.length * dur > 15000) flush();
  setMicLabel();
}

async function startMic() {
  if (!me) return toast("Join the huddle first");
  mic.stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  try { mic.ctx = new AudioContext({ sampleRate: 16000 }); } catch { mic.ctx = new AudioContext(); }
  const src = mic.ctx.createMediaStreamSource(mic.stream);
  mic.proc = mic.ctx.createScriptProcessor(4096, 1, 1);
  mic.proc.onaudioprocess = (e) => {
    onAudio(e.inputBuffer.getChannelData(0));
    e.outputBuffer.getChannelData(0).fill(0);
  };
  src.connect(mic.proc);
  mic.proc.connect(mic.ctx.destination);
  mic.on = true;
  roomChannel?.track({ name: me, clientId, mic: true });
  setMicLabel();
  toast("Mic on. Huddle is listening.");
}
function stopMic() {
  if (mic.frames.length) flush();
  mic.proc?.disconnect();
  mic.stream?.getTracks().forEach((t) => t.stop());
  mic.ctx?.close();
  mic.on = false;
  $("meterFill").style.width = "0%";
  roomChannel?.track({ name: me, clientId, mic: false });
  setMicLabel();
  toast("Muted. Huddle can’t hear you.");
}
const toggleMic = async () => {
  try { mic.on ? stopMic() : await startMic(); }
  catch (e) { toast(`Mic unavailable: ${e.message}`); }
};
$("micBtn").onclick = toggleMic;
$("mMicBtn").onclick = toggleMic;
$("micMode").onchange = () => { mic.frames = []; mic.speaking = false; setMicLabel(); };
const typing = () => ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
window.addEventListener("keydown", (ev) => {
  if (ev.code === "Space" && mic.on && $("micMode").value === "ptt" && !typing() && !ev.repeat) {
    ev.preventDefault(); mic.pttDown = true; setMicLabel();
  }
});
window.addEventListener("keyup", (ev) => {
  if (ev.code === "Space" && mic.pttDown) { mic.pttDown = false; flush(true); }
});

// ==========================================================================
// PRESENCE
// ==========================================================================
function renderPeers() {
  const wrap = $("peers");
  wrap.innerHTML = "";
  const seen = new Map();
  for (const p of state.peers) {
    if (!p.name) continue;
    const prev = seen.get(p.name);
    seen.set(p.name, { ...p, mic: p.mic || prev?.mic, tabs: (prev?.tabs || 0) + 1, you: p.clientId === clientId || prev?.you });
  }
  for (const p of seen.values()) {
    wrap.append(h("span", { class: `pav${p.mic ? " mic" : ""}`, style: `background:${colorFor(p.name)}`,
      title: `${p.name}${p.you ? " (you)" : ""}${p.mic ? " · mic on" : ""}${p.tabs > 1 ? ` · ${p.tabs} tabs` : ""}` }, p.name.slice(0, 1).toUpperCase()));
  }
  renderJoinInfo();
}

// ==========================================================================
// JOIN
// ==========================================================================
function renderJoinInfo() {
  if ($("join").hidden) return;
  const s = state.brain?.state || {};
  $("joinRoom").textContent = roomLabel(room);
  const here = [...new Set(state.peers.map((p) => p.name).filter(Boolean))];
  const recent = [...new Set([...state.events.values()].filter((e) => e.kind !== "system" && e.author !== "huddle").map((e) => e.author))].slice(-3);
  const names = here.length ? here : recent;
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
  $("joinWho").textContent = !names.length ? "You’re the first one here." : here.length ? `${list} ${names.length === 1 ? "is" : "are"} here.` : `${list} ${names.length === 1 ? "has" : "have"} been here.`;
  $("joinGoalBox").hidden = !s.goal;
  $("joinGoal").textContent = s.goal || "";
  const made = doneJobs();
  const lines = s.goal ? [
    ["Decided", s.decisions?.[0]?.text || "Nothing yet"],
    ["Still open", s.questions?.[0]?.text || "Nothing yet"],
    ["Made", made.length ? `${made.length} ${made.length === 1 ? "thing" : "things"} so far, like “${clip(made[0].title, 70)}”` : "Nothing yet"],
  ] : [];
  $("joinLines").hidden = !lines.length;
  $("joinLines").innerHTML = "";
  lines.forEach(([k, v]) => $("joinLines").append(h("p", { class: "jline" }, h("span", { class: "jk" }, k), v)));
}
function join() {
  me = $("joinName").value.trim().slice(0, 30) || "guest";
  store.set("huddle:name", me);
  $("join").hidden = true;
  roomChannel?.track({ name: me, clientId, mic: false });
  toast("You’re in. Press Talk when you want Huddle to hear you.");
  afterJoin();
}
$("joinBtn").onclick = join;
$("joinName").addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); join(); } });

// A goal typed when the huddle was created becomes its first note, and starts the brief.
async function afterJoin() {
  const goal = store.get(`huddle:goal:${room}`);
  if (!goal) return;
  store.del(`huddle:goal:${room}`);
  await sb.from("events").insert({ room_id: room, author: me, kind: "note", text: `Our goal: ${goal}` });
  synthesize(true);
}

// ==========================================================================
// REALTIME
// ==========================================================================
let roomChannel = null;

async function loadInitial() {
  await sb.from("rooms").upsert({ id: room }, { onConflict: "id", ignoreDuplicates: true });
  const [ev, jobs, brain, pipes, roomRow] = await Promise.all([
    sb.from("events").select("*").eq("room_id", room).order("id", { ascending: false }).limit(200),
    sb.from("jobs").select("*").eq("room_id", room).order("id"),
    sb.from("brain").select("*").eq("room_id", room).maybeSingle(),
    sb.from("pipelines").select("*").eq("room_id", room).order("id"),
    sb.from("rooms").select("*").eq("id", room).maybeSingle(),
  ]);
  if (ev.error) toast(`Can't reach the server: ${ev.error.message}`, 6000);
  (ev.data || []).forEach((e) => state.events.set(e.id, e));
  (jobs.data || []).forEach((j) => state.jobs.set(j.id, j));
  (pipes.data || []).forEach((p) => state.pipelines.set(p.id, p));
  state.brain = brain.data;
  state.room = roomRow.data;
  renderAll();
  // Start at the newest input (again after images load, which changes the height).
  const toBottom = () => { const l = $("events"); l.scrollTop = l.scrollHeight; };
  requestAnimationFrame(() => requestAnimationFrame(toBottom));
  setTimeout(toBottom, 600);
}

function subscribe() {
  sb.channel(`db-${room}`)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "events", filter: `room_id=eq.${room}` },
      ({ new: e }) => { state.events.set(e.id, e); renderStream(); renderBoardGallery(); })
    .on("postgres_changes", { event: "*", schema: "public", table: "jobs", filter: `room_id=eq.${room}` },
      ({ new: j }) => {
        const prev = state.jobs.get(j.id);
        state.jobs.set(j.id, j);
        renderWork(); renderBrain();
        if (!j.pipeline_id && prev && prev.status !== "done" && j.status === "done") toast(`Ready: ${j.title}`);
      })
    .on("postgres_changes", { event: "*", schema: "public", table: "brain", filter: `room_id=eq.${room}` },
      ({ new: b }) => { state.brain = b; renderBrain(); renderJoinInfo(); })
    .on("postgres_changes", { event: "*", schema: "public", table: "pipelines", filter: `room_id=eq.${room}` },
      ({ new: p }) => {
        const prev = state.pipelines.get(p.id);
        state.pipelines.set(p.id, p);
        renderWork();
        if (p.status === "waiting" && prev?.status !== "waiting") toast(`Needs the room: ${p.title}`);
        if (p.host_url && !prev?.host_url) toast(`Live: ${p.title}`);
      })
    .on("postgres_changes", { event: "*", schema: "public", table: "rooms", filter: `id=eq.${room}` },
      ({ new: r }) => { state.room = r; renderWork(); })
    .subscribe();

  roomChannel = sb.channel(`room-${room}`, { config: { presence: { key: clientId }, broadcast: { self: false } } });
  roomChannel
    .on("presence", { event: "sync" }, () => {
      const st = roomChannel.presenceState();
      state.peers = Object.values(st).map((arr) => arr[arr.length - 1]);
      renderPeers();
    })
    .on("broadcast", { event: "stroke" }, ({ payload }) => drawStroke(payload.pts, payload.color))
    .on("broadcast", { event: "clear" }, () => { clearCanvas(); boardDirty = false; })
    .subscribe((status) => {
      if (status === "SUBSCRIBED" && me) roomChannel.track({ name: me, clientId, mic: false });
    });
}

async function start() {
  if (!me) { $("join").hidden = false; renderJoinInfo(); }
  await loadInitial();
  subscribe();
  if (!me) $("joinName").focus();
  else afterJoin();
}

setView("brief");
setMicLabel();
if (SUPABASE_URL.includes("YOUR-PROJECT")) {
  toast("Set SUPABASE_URL and SUPABASE_KEY in web/config.js", 10000);
} else {
  start();
}
