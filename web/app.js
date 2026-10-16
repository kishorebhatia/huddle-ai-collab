import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { marked } from "https://esm.sh/marked@12.0.2";
import DOMPurify from "https://esm.sh/dompurify@3.1.6";
import * as config from "./config.js";
const { SUPABASE_URL, SUPABASE_KEY } = config;

// Signed in with GitHub? The sign-in callback hands back a Huddle token in the URL fragment.
function readAuth() {
  const ls = (k, v) => { try { return v === undefined ? localStorage.getItem(k) : v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { return null; } };
  const frag = new URLSearchParams(location.hash.slice(1));
  if (frag.get("huddle_token")) {
    ls("huddle:token", frag.get("huddle_token"));
    ls("huddle:user", frag.get("huddle_user") || "{}");
    history.replaceState(null, "", location.pathname + location.search);
  }
  const token = ls("huddle:token");
  try {
    const { exp } = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (exp * 1000 > Date.now()) return { token, user: JSON.parse(ls("huddle:user") || "{}") };
  } catch { /* no token, or not ours */ }
  ls("huddle:token", null); ls("huddle:user", null);
  return { token: null, user: null };
}
const auth = readAuth();
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, auth.token ? { global: { headers: { Authorization: `Bearer ${auth.token}` } } } : {});
if (auth.token) sb.realtime.setAuth(auth.token);
const signIn = (scope = "") => {
  location.href = `/auth/github/login?return=${encodeURIComponent(location.pathname + location.search)}${scope ? `&scope=${scope}` : ""}`;
};
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
let me = store.get("huddle:name") || auth.user?.name || auth.user?.login || "";

// Rooms you've been in live in this browser only (no accounts yet).
const myRooms = store.json("huddle:rooms", []);
if (!myRooms.find((r) => r.id === room)) myRooms.unshift({ id: room, name: "" });
store.set("huddle:rooms", JSON.stringify(myRooms.slice(0, 20)));
// The current room's name is shared (rooms.name); other rooms fall back to what this browser remembers.
const roomLabel = (id) => (id === room && state?.room?.name) || myRooms.find((r) => r.id === id)?.name || `Room ${id}`;
$("roomName").textContent = myRooms.find((r) => r.id === room)?.name || `Room ${room}`;
$("roomCode").textContent = room;
document.title = `${$("roomName").textContent} · Huddle`;

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
const state = { events: new Map(), jobs: new Map(), pipelines: new Map(), board: new Map(), brain: null, peers: [], room: null };
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
    renderStream(); renderBrain(); renderBoard(); renderWork(); renderJoinInfo();
  });
}

// ==========================================================================
// STREAM — people only. Speech clips from one person in a row merge into one paragraph.
// ==========================================================================
const KIND_LABEL = { speech: "said", note: "note", link: "link", image: "image", finding: "finding", feedback: "feedback", voice: "voice note", video: "video", file: "file" };
const FILTERS = { voice: ["speech", "voice"], text: ["note", "link", "finding", "feedback"], media: ["image", "video", "file"] };
const STREAM_LIMIT = 30;
const idToGroup = new Map();

function groupEvents() {
  const evs = [...state.events.values()].filter((e) => e.kind !== "system" && !e.forgotten).sort((a, b) => a.id - b.id);
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
    } else if (g.kind === "voice") {
      el.append(h("div", { class: "evmedia" }, h("audio", { src: g.e.meta?.url, controls: true, preload: "metadata" })));
      const text = g.e.text || "";
      const long = text.length > 280;
      el.append(h("div", { class: `evb${long && !open ? " clamp" : ""}` }, text));
      if (long) el.append(h("div", { class: "evlinks" }, toggle(open ? "Show less" : "Show more")));
    } else if (g.kind === "video" || g.kind === "file") {
      const box = h("div", { class: "evmedia" });
      if (g.kind === "video") box.append(h("video", { src: g.e.meta?.url, controls: true, preload: "metadata", playsinline: true }));
      else box.append(h("div", { class: "filerow" }, svgIcon('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>', 18),
        h("a", { href: g.e.meta?.url, target: "_blank", rel: "noopener", class: "grow" }, g.e.meta?.name || "Open file")));
      el.append(box);
      if (g.e.text) {
        el.append(h("div", { class: "evlinks" }, toggle(open ? "Hide" : g.kind === "video" ? "What Huddle saw" : "What Huddle read")));
        if (open) el.append(h("div", { class: "saw", style: "margin-left:30px", html: md(g.e.text) }));
      }
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

  const lockedSet = new Set((b?.locked || []).map((l) => l.text));
  const fill = (id, items = [], emptyText, label, withType, lockable) => {
    const box = $(id);
    box.innerHTML = "";
    if (!items.length) box.append(h("p", { class: "empty" }, emptyText));
    for (const it of items) {
      const sel = ui.thread?.item?.text === it.text;
      const refs = h("span", { class: "refs" }, it.owner || it.by || "", ...(it.refs || []).slice(0, 4).map((r) => h("span", { class: "ref" }, `#${r}`)));
      const locked = lockedSet.has(it.text);
      box.append(h("div", { class: `item${sel ? " sel" : ""}` },
        withType ? h("span", { class: `tb ${it.type || "todo"}` }, it.type || "todo") : null,
        h("button", { class: "ibody", onclick: () => setThread(it, label) }, h("span", { class: "itext" }, it.text), refs),
        lockable ? h("button", { class: `lock${locked ? " on" : ""}`, onclick: () => toggleLock(it, locked),
          "aria-label": locked ? "Unlock this decision" : "Lock this decision",
          title: locked ? "Locked by the team. Huddle won't change it. Click to unlock." : "Lock this decision so Huddle never rewrites it" },
          svgIcon(locked ? '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>' : '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>', 15)) : null));
    }
  };
  fill("bDecisions", s.decisions, "Nothing decided yet. Huddle adds decisions as you make them.", "Decision", false, true);
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

async function toggleLock(it, locked) {
  if (!me) return toast("Join the huddle first");
  if (!state.brain) return;
  const before = state.brain.locked || [];
  state.brain.locked = locked ? before.filter((l) => l.text !== it.text) : [...before, { text: it.text, by: it.by, refs: it.refs || [] }];
  renderBrain();
  try {
    const r = await fn("brain-edit", { room, action: locked ? "unlock" : "lock", text: it.text, by: it.by, refs: it.refs || [] });
    state.brain.locked = r.locked;
    toast(locked ? "Unlocked. Huddle may edit this line again." : "Locked. Huddle won't change this decision.");
  } catch (e) {
    state.brain.locked = before;
    toast(`Couldn't ${locked ? "unlock" : "lock"}: ${e.message}`);
  }
  renderBrain();
}

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
// BOARD — one endless, shared surface. Cards (notes, sketches, anything shared, agent outputs, the brief)
// live in board_items with a position; everyone sees moves and edits live.
// ==========================================================================
const boardView = { x: 40, y: 70, z: 0.85 };
let penColor = "#1E2A22";
let pen = null; // { strokes: [{ color, pts: [[x,y],…] }] } while sketching
const BRIEF_KEY = "brief";
const boardItems = () => [...state.board.values()].filter((b) => !b.removed);

function applyBoardView() {
  $("blayer").style.transform = `translate(${boardView.x}px, ${boardView.y}px) scale(${boardView.z})`;
  const g = 22 * boardView.z;
  $("bsurf").style.backgroundSize = `${g}px ${g}px`;
  $("bsurf").style.backgroundPosition = `${boardView.x}px ${boardView.y}px`;
  $("zoomLabel").textContent = `${Math.round(boardView.z * 100)}%`;
}
const toBoard = (clientX, clientY) => {
  const r = $("bsurf").getBoundingClientRect();
  return [(clientX - r.left - boardView.x) / boardView.z, (clientY - r.top - boardView.y) / boardView.z];
};
function viewCenter() {
  const r = $("bsurf").getBoundingClientRect();
  const w = r.width || 900, hgt = r.height || 600;
  return [(w / 2 - boardView.x) / boardView.z, (hgt / 2 - boardView.y) / boardView.z];
}
function setZoom(z, cx, cy) {
  const nz = Math.max(0.25, Math.min(2.5, z));
  if (cx == null) { const r = $("bsurf").getBoundingClientRect(); cx = r.width / 2; cy = r.height / 2; }
  boardView.x = cx - ((cx - boardView.x) / boardView.z) * nz;
  boardView.y = cy - ((cy - boardView.y) / boardView.z) * nz;
  boardView.z = nz;
  applyBoardView();
}
function fitBoard() {
  const cards = [...$("blayer").querySelectorAll(".bit")];
  const r = $("bsurf").getBoundingClientRect();
  if (!cards.length || !r.width) { boardView.x = 40; boardView.y = 70; boardView.z = 0.85; return applyBoardView(); }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of cards) {
    const x = parseFloat(c.style.left), y = parseFloat(c.style.top);
    x0 = Math.min(x0, x); y0 = Math.min(y0, y);
    x1 = Math.max(x1, x + c.offsetWidth); y1 = Math.max(y1, y + c.offsetHeight);
  }
  const z = Math.max(isMobile() ? 0.45 : 0.25, Math.min(1.2, Math.min((r.width - 80) / (x1 - x0), (r.height - 130) / (y1 - y0))));
  boardView.z = z;
  boardView.x = (r.width - (x1 - x0) * z) / 2 - x0 * z;
  boardView.y = 64 + (r.height - 64 - (y1 - y0) * z) / 2 - y0 * z;
  applyBoardView();
}
$("zoomIn").onclick = () => setZoom(boardView.z + 0.1);
$("zoomOut").onclick = () => setZoom(boardView.z - 0.1);
$("zoomFit").onclick = fitBoard;

/** The open spot nearest the middle of what you're looking at, so new cards don't pile up. */
function freeSpot(w, hgt) {
  const rects = [...$("blayer").querySelectorAll(".bit")].map((c) => ({
    x: parseFloat(c.style.left), y: parseFloat(c.style.top), w: c.offsetWidth, h: c.offsetHeight }));
  const [cx, cy] = viewCenter();
  const gap = 18, step = 40;
  const free = (x, y) => rects.every((r) => x + w + gap < r.x || x > r.x + r.w + gap || y + hgt + gap < r.y || y > r.y + r.h + gap);
  for (let ring = 0; ring < 30; ring++) {
    for (let i = -ring; i <= ring; i++) {
      for (const [dx, dy] of [[i, -ring], [i, ring], [-ring, i], [ring, i]]) {
        const x = Math.round(cx - w / 2 + dx * step), y = Math.round(cy - hgt / 2 + dy * step);
        if (free(x, y)) return [x, y];
      }
    }
  }
  return [Math.round(cx - w / 2), Math.round(cy - hgt / 2)];
}

/** Create a card where you can see it. */
async function placeOnBoard({ kind, data = {}, w = 260 }) {
  const [x, y] = freeSpot(w, kind === "note" ? 140 : 220);
  const row = { room_id: room, kind, data, w, x, y, created_by: me || "someone" };
  const { data: item, error } = await sb.from("board_items").insert(row).select().single();
  if (error) { toast(`Couldn't add to the board: ${error.message}`); return null; }
  state.board.set(item.id, item);
  renderBoard();
  return item;
}
async function moveItem(item, x, y) {
  if (item.virtual) {
    // The brief card exists for everyone; it gets a saved position the first time someone moves it.
    const { data, error } = await sb.from("board_items").insert({ room_id: room, kind: "brief", x, y, w: item.w, created_by: me }).select().single();
    if (!error) state.board.set(data.id, data);
  } else {
    Object.assign(item, { x, y });
    await sb.from("board_items").update({ x, y, updated_at: new Date().toISOString() }).eq("id", item.id);
  }
  renderBoard();
}
async function removeItem(item) {
  if (item.virtual) return;
  item.removed = true;
  renderBoard();
  await sb.from("board_items").update({ removed: true }).eq("id", item.id);
}
const noteTimers = new Map();
function saveNote(item, text) {
  item.data = { ...item.data, text };
  clearTimeout(noteTimers.get(item.id));
  noteTimers.set(item.id, setTimeout(() => sb.from("board_items").update({ data: item.data, updated_at: new Date().toISOString() }).eq("id", item.id), 500));
}

function sketchSvg(data) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("class", "sk");
  s.setAttribute("viewBox", `0 0 ${Math.max(1, data.w || 1)} ${Math.max(1, data.h || 1)}`);
  s.setAttribute("role", "img");
  s.setAttribute("aria-label", "Sketch");
  for (const p of data.paths || []) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", p.pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" "));
    path.setAttribute("fill", "none"); path.setAttribute("stroke", p.color || "#1E2A22");
    path.setAttribute("stroke-width", "3"); path.setAttribute("stroke-linecap", "round"); path.setAttribute("stroke-linejoin", "round");
    s.append(path);
  }
  return s;
}
/** Render a sketch to a PNG so Huddle can read it into the brief. */
function sketchToPng(data) {
  return new Promise((resolve) => {
    const pad = 20, c = document.createElement("canvas");
    c.width = Math.max(200, data.w + pad * 2); c.height = Math.max(120, data.h + pad * 2);
    const g = c.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
    g.lineWidth = 4; g.lineCap = "round"; g.lineJoin = "round";
    for (const p of data.paths || []) {
      g.strokeStyle = p.color; g.beginPath();
      p.pts.forEach(([x, y], i) => (i ? g.lineTo(x + pad, y + pad) : g.moveTo(x + pad, y + pad)));
      g.stroke();
    }
    c.toBlob(resolve, "image/png");
  });
}

function cardBody(item) {
  const s = state.brain?.state || {};
  if (item.kind === "brief") {
    return [h("span", { class: "kb" }, "The brief · live"),
      h("b", { style: "font-family:Manrope,sans-serif;font-size:16px;margin-top:4px" }, s.goal || "No goal yet."),
      s.summary ? h("small", {}, clip(s.summary, 220)) : null,
      (s.decisions || []).length ? h("small", {}, `Decided: ${(s.decisions || []).slice(0, 3).map((d) => clip(d.text, 60)).join(" · ")}`) : null];
  }
  if (item.kind === "note") {
    const ta = h("textarea", { placeholder: "Type a note…", "aria-label": "Note text" });
    ta.value = item.data?.text || "";
    ta.addEventListener("input", () => saveNote(item, ta.value));
    return [ta, h("span", { class: "who" }, item.created_by)];
  }
  if (item.kind === "sketch") {
    return [sketchSvg(item.data || {}),
      h("div", { class: "crow" }, h("span", { class: "who grow" }, item.created_by),
        h("button", { class: "link", onclick: async () => { const png = await sketchToPng(item.data || {}); if (png) shareImage(png, "board sketch"); } }, "Send to the brief"))];
  }
  if (item.kind === "output") {
    const j = state.jobs.get(Number(item.data?.job_id));
    if (!j) return [h("small", {}, "Agent output")];
    return [h("span", { class: `kb ${j.kind}` }, j.kind === "prototype" ? "Prototype" : "Research"), h("b", {}, j.title),
      h("small", {}, clip(plain(j.output_md), 140)), h("button", { class: "link", onclick: () => openViewer(j.id) }, "Open")];
  }
  const e = state.events.get(Number(item.data?.event_id));
  if (!e) return [h("small", {}, "Loading…")];
  if (e.forgotten) return [h("small", {}, "Erased by its author.")];
  const title = (e.text || "").match(/^\*\*(.+?)\*\*/)?.[1] || e.meta?.title || e.meta?.name || "";
  const who = h("span", { class: "who" }, `${e.author} · ${clock(e.created_at)}`);
  if (e.kind === "image") return [h("img", { src: e.image_url, alt: title || "Shared image", loading: "lazy" }), title ? h("b", { style: "margin-top:6px" }, title) : null, who];
  if (e.kind === "video") return [h("video", { src: e.meta?.url, controls: true, preload: "metadata" }), title ? h("b", { style: "margin-top:6px" }, title) : null, who];
  if (e.kind === "voice") return [h("span", { class: "kb" }, "Voice note"), h("audio", { src: e.meta?.url, controls: true, preload: "metadata" }), h("small", {}, clip(e.text || "", 160)), who];
  if (e.kind === "file") return [h("span", { class: "kb" }, "File"), h("a", { href: e.meta?.url, target: "_blank", rel: "noopener" }, e.meta?.name || "Open file"), title ? h("small", {}, title) : null, who];
  if (e.kind === "link") return [h("span", { class: "kb" }, "Link"), h("a", { href: e.text, target: "_blank", rel: "noopener" }, clip(e.text || "", 80)), who];
  return [h("small", {}, clip(plain(e.text), 200)), who];
}

function renderBoard() {
  const layer = $("blayer");
  const focused = document.activeElement?.closest?.(".bit")?.dataset.id;
  [...layer.querySelectorAll(".bit")].forEach((n) => { if (n.dataset.id !== focused) n.remove(); });
  const items = boardItems();
  if (!items.some((b) => b.kind === "brief")) items.unshift({ id: BRIEF_KEY, virtual: true, kind: "brief", x: 40, y: 40, w: 380 });
  for (const item of items) {
    if (String(item.id) === focused) continue; // don't yank the note someone is typing in
    const card = h("div", { class: `bit ${item.kind}`, "data-id": String(item.id), style: `left:${item.x}px;top:${item.y}px;width:${item.w}px` },
      item.virtual ? null : h("button", { class: "x", "aria-label": "Remove from the board", title: "Remove from the board", onclick: () => removeItem(item) }, "×"),
      ...cardBody(item));
    card.addEventListener("pointerdown", (ev) => startCardDrag(ev, card, item));
    layer.append(card);
  }
}

// Dragging cards, panning the surface, drawing sketches
let drag = null;
function startCardDrag(ev, card, item) {
  if (pen || ev.button > 0) return;
  if (ev.target.closest("textarea, button, a, audio, video, input")) return;
  ev.stopPropagation();
  card.setPointerCapture(ev.pointerId);
  card.classList.add("dragging");
  drag = { card, item, sx: ev.clientX, sy: ev.clientY, ox: item.x, oy: item.y, moved: false };
}
$("bsurf").addEventListener("pointerdown", (ev) => {
  if (ev.button > 0) return;
  $("addMenu").hidden = true;
  if (pen) {
    $("bsurf").setPointerCapture(ev.pointerId);
    pen.current = { color: penColor, pts: [toBoard(ev.clientX, ev.clientY)] };
    pen.strokes.push(pen.current);
    return drawInk();
  }
  $("bsurf").setPointerCapture(ev.pointerId);
  $("bsurf").classList.add("panning");
  drag = { pan: true, sx: ev.clientX, sy: ev.clientY, ox: boardView.x, oy: boardView.y };
});
window.addEventListener("pointermove", (ev) => {
  if (pen?.current) { pen.current.pts.push(toBoard(ev.clientX, ev.clientY)); return drawInk(); }
  if (!drag) return;
  const dx = ev.clientX - drag.sx, dy = ev.clientY - drag.sy;
  if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
  if (drag.pan) { boardView.x = drag.ox + dx; boardView.y = drag.oy + dy; applyBoardView(); }
  else { drag.card.style.left = `${drag.ox + dx / boardView.z}px`; drag.card.style.top = `${drag.oy + dy / boardView.z}px`; }
});
window.addEventListener("pointerup", (ev) => {
  if (pen?.current) { pen.current = null; return; }
  if (!drag) return;
  const d = drag; drag = null;
  $("bsurf").classList.remove("panning");
  if (d.pan || !d.moved) { d.card?.classList.remove("dragging"); return; }
  d.card.classList.remove("dragging");
  moveItem(d.item, Math.round(d.ox + (ev.clientX - d.sx) / boardView.z), Math.round(d.oy + (ev.clientY - d.sy) / boardView.z));
});
$("bsurf").addEventListener("wheel", (ev) => {
  ev.preventDefault();
  if (ev.ctrlKey || ev.metaKey) {
    const r = $("bsurf").getBoundingClientRect();
    setZoom(boardView.z * (ev.deltaY > 0 ? 0.92 : 1.08), ev.clientX - r.left, ev.clientY - r.top);
  } else { boardView.x -= ev.deltaX; boardView.y -= ev.deltaY; applyBoardView(); }
}, { passive: false });

function drawInk() {
  const svg = $("ink");
  svg.innerHTML = "";
  for (const s of pen?.strokes || []) {
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", s.pts.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join(" "));
    p.setAttribute("fill", "none"); p.setAttribute("stroke", s.color); p.setAttribute("stroke-width", "3");
    p.setAttribute("stroke-linecap", "round"); p.setAttribute("stroke-linejoin", "round");
    svg.append(p);
  }
}
function startPen() {
  if (!me) return toast("Join the huddle first");
  pen = { strokes: [], current: null };
  $("bsurf").classList.add("pen");
  $("penBar").hidden = false; $("addBtn").hidden = true; $("addMenu").hidden = true;
  toast("Draw anywhere on the board. Press Done when you're finished.");
}
async function endPen(save) {
  const strokes = (pen?.strokes || []).filter((s) => s.pts.length > 1);
  pen = null;
  $("ink").innerHTML = "";
  $("bsurf").classList.remove("pen");
  $("penBar").hidden = true; $("addBtn").hidden = false;
  if (!save || !strokes.length) return;
  const all = strokes.flatMap((s) => s.pts);
  const x0 = Math.min(...all.map((p) => p[0])), y0 = Math.min(...all.map((p) => p[1]));
  const x1 = Math.max(...all.map((p) => p[0])), y1 = Math.max(...all.map((p) => p[1]));
  const data = { w: Math.round(x1 - x0), h: Math.round(y1 - y0), paths: strokes.map((s) => ({ color: s.color, pts: s.pts.map(([x, y]) => [Math.round((x - x0) * 10) / 10, Math.round((y - y0) * 10) / 10]) })) };
  const pad = 10;
  const { data: item, error } = await sb.from("board_items")
    .insert({ room_id: room, kind: "sketch", x: Math.round(x0 - pad), y: Math.round(y0 - pad), w: Math.max(120, data.w + pad * 2), data, created_by: me })
    .select().single();
  if (error) return toast(`Couldn't save the sketch: ${error.message}`);
  state.board.set(item.id, item);
  renderBoard();
  toast("Sketch saved. Use “Send to the brief” on it when you want Huddle to read it.");
}
$("penDone").onclick = () => endPen(true);
$("penCancel").onclick = () => endPen(false);
document.querySelectorAll("#penBar .swatch").forEach((b) => (b.onclick = () => {
  document.querySelectorAll("#penBar .swatch").forEach((x) => x.classList.remove("on"));
  b.classList.add("on");
  penColor = b.dataset.color;
}));

$("addBtn").onclick = (ev) => { ev.stopPropagation(); $("addMenu").hidden = !$("addMenu").hidden; $("addBtn").setAttribute("aria-expanded", String(!$("addMenu").hidden)); };
document.querySelectorAll("[data-add]").forEach((b) => (b.onclick = () => {
  $("addMenu").hidden = true;
  const k = b.dataset.add;
  if (!me) return toast("Join the huddle first");
  if (k === "note") return placeOnBoard({ kind: "note", data: { text: "" }, w: 220 }).then((it) => it && $("blayer").querySelector(`.bit[data-id="${it.id}"] textarea`)?.focus());
  if (k === "sketch") return startPen();
  if (k === "voice") return startVoiceNote();
  const picker = document.querySelector(`.comp input.pick[data-kind="${k}"]`) || document.querySelector(`input.pick[data-kind="${k}"]`);
  picker?.click();
}));
applyBoardView();

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

// A build needs keys: masked fields that post straight to the secrets function (never into the stream).
// Cached per gate so the frequent re-renders of this panel don't wipe what someone is typing.
const secretForms = new Map();
function secretForm(p) {
  const key = `${p.id}:${p.gate.stage}`;
  if (secretForms.has(key)) return secretForms.get(key);
  const inputs = p.gate.inputs || [];
  const server = p.gate.kind === "server_secret"; // operator room: keys for the production server, admins only
  const wrap = h("div", { class: "secretform" });
  const fields = inputs.map((i) => {
    const inp = h("input", { class: "inp", type: "password", autocomplete: "off", spellcheck: "false", placeholder: i.name, "aria-label": i.label });
    const useSaved = h("button", { class: "btn ghost sm", hidden: true, disabled: server, onclick: async () => {
      try { await fn("secrets", { room, action: "use_saved", name: i.name }); inp.value = ""; inp.placeholder = "Using your saved key"; inp.disabled = true; }
      catch (e) { toast(e.message); }
    } }, "Use my saved key");
    wrap.append(h("label", { class: "small lab" }, i.label, i.get_url ? h("a", { href: i.get_url, target: "_blank", rel: "noopener" }, " · get one ↗") : null),
      h("div", { class: "crow" }, inp, useSaved), i.why ? h("p", { class: "hint" }, `Used ${i.why.replace(/^to /, "to ")}.`) : null);
    return { i, inp, useSaved };
  });
  const save = auth.token && !server ? h("input", { type: "checkbox", checked: true, id: `save${p.id}` }) : null;
  const go = h("button", { class: "btn amber sm" }, "Save and continue");
  go.onclick = async () => {
    go.disabled = true;
    try {
      for (const f of fields) {
        const v = f.inp.value.trim();
        if (v) await fn("secrets", server ? { room, action: "set_server", name: f.i.name, value: v } : { room, action: "set", name: f.i.name, value: v, save: !!save?.checked });
        f.inp.value = "";
      }
      const r = await fn("orchestrate", { pipeline_id: p.id, action: "approve" });
      if (r?.missing?.length) toast(`Still needed: ${r.missing.join(", ")}`);
      else { secretForms.delete(key); toast("Saved. The build continues."); }
    } catch (e) { toast(e.message); }
    go.disabled = false;
  };
  wrap.append(
    server ? h("p", { class: "hint" }, "Only a Huddle admin can add these. They go into the production server's environment, never into git or the room.")
    : save ? h("label", { class: "small crow", for: `save${p.id}` }, save, "Also save to my account for my other huddles")
      : h("p", { class: "hint" }, "Signed in? Keys can be saved to your account and reused in huddles you own."),
    h("div", { class: "crow" }, go, h("button", { class: "btn ghost sm", onclick: () => pipeAct(p.id, "skip") }, "Skip this build")),
    h("p", { class: "hint" }, "Encrypted, used only by this build's sandbox, never shown in the room, the repo or the logs."));
  if (auth.token && !server) {
    fn("secrets", { room, action: "status", names: inputs.map((i) => i.name) })
      .then((st) => fields.forEach((f) => { if (st.saved?.includes(f.i.name)) f.useSaved.hidden = false; })).catch(() => {});
  }
  secretForms.set(key, wrap);
  return wrap;
}

// What each integration did for a pipeline: Anchor (live view, screenshot), Daytona (sandbox URL),
// Arize (eval scores, trace). Only shows on deploys that have them (AWS build).
const EVAL_LABEL = { groundedness: "Grounded", review_score: "Review", smoke_test: "Smoke test", build_success: "Build", faithfulness: "Faithful", secret_free: "No secrets" };
function proofRow(p) {
  const metas = jobsOf(p.id).map((j) => j.meta || {});
  const pick = (k) => metas.map((m) => m[k]).filter(Boolean).pop();
  const evals = {};
  for (const m of metas) for (const [k, v] of Object.entries(m.evals || {})) evals[k] = v;
  const live = p.status === "running" ? pick("live_view_url") : null;
  const shot = pick("screenshot_url"), sandbox = pick("sandbox_url"), trace = pick("trace_id");
  if (!live && !shot && !sandbox && !trace && !Object.keys(evals).length) return null;
  const a = (href, text, cls, title) => h("a", { class: `proof ${cls}`, href, target: "_blank", rel: "noopener", title, onclick: (ev) => ev.stopPropagation() }, text);
  const fmt = (k, v) => k === "review_score" ? `${Math.round(v * 10)}/10` : ["smoke_test", "build_success"].includes(k) ? (v >= 1 ? "pass" : "fail") : v.toFixed(2);
  const arize = config.ARIZE_PROJECT_URL;
  return h("div", { class: "proofs" },
    live ? a(live, "● Watch Anchor live", "anchor live", "Anchor's cloud browser testing the prototype right now") : null,
    shot ? a(shot, "Anchor screenshot", "anchor", "What Anchor's browser saw during the smoke test") : null,
    sandbox ? a(sandbox, "Daytona sandbox ↗", "daytona", "The prototype running in its Daytona sandbox") : null,
    ...Object.entries(evals).map(([k, v]) => h("span", {
      class: `proof eval ${v.score >= 0.7 ? "ok" : "low"}`, title: `Arize eval "${k}": ${v.explanation || ""}`,
    }, `${EVAL_LABEL[k] || k} ${fmt(k, v.score)}`)),
    trace ? (arize ? a(arize, "Arize trace ↗", "arize", `Trace ${trace} in Arize AX`) : h("span", { class: "proof arize", title: trace }, `Arize trace ${trace.slice(0, 8)}`)) : null);
}
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
    } else if (p.gate.kind === "secret" || p.gate.kind === "server_secret") {
      card.append(secretForm(p));
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
    const proof = proofRow(p);
    if (proof) run.append(proof);
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
      const proof = proofRow(p);
      if (proof) done.append(proof);
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
$("vPin").onclick = async () => {
  if (!viewing) return;
  if (boardItems().some((b) => b.kind === "output" && Number(b.data?.job_id) === viewing)) { toast("It's already on the board."); }
  else { await placeOnBoard({ kind: "output", data: { job_id: viewing }, w: 280 }); toast("Added to the board."); }
  $("viewer").hidden = true;
  setView("board");
};
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
// SHARING INTO THE ROOM: notes, links, images, video, voice notes, files.
// Everything shared lands in the stream, and media also lands on the board.
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

const MAX_UPLOAD = 50 * 1024 * 1024;
const safeName = (s) => (s || "upload").replace(/[^\w.\-]+/g, "_").slice(-80);
async function upload(blob, folder, name) {
  if (blob.size > MAX_UPLOAD) throw new Error("that file is over 50 MB");
  const path = `${room}/${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${safeName(name)}`;
  const up = await sb.storage.from("board").upload(path, blob, { contentType: blob.type || "application/octet-stream" });
  if (up.error) throw up.error;
  return sb.storage.from("board").getPublicUrl(path).data.publicUrl;
}
function kindOf(file) {
  const t = file.type || "";
  if (t.startsWith("image/")) return "image";
  if (t.startsWith("video/")) return "video";
  if (t.startsWith("audio/")) return "voice";
  return "file";
}
const SHARING = { image: "image", video: "video", voice: "voice note", file: "file" };

/** Share any file. kind: image | video | voice | file. Lands in the stream and on the board. */
async function shareFile(file, kind = kindOf(file), caption = "") {
  if (!me) return toast("Join the huddle first");
  const name = file.name || (kind === "voice" ? "voice-note.wav" : kind === "image" ? "image.png" : "upload");
  $("sendStatus").textContent = `Sharing ${SHARING[kind]}…`;
  toast(`Sharing your ${SHARING[kind]}. Huddle is ${kind === "voice" ? "listening to" : kind === "video" ? "watching" : "reading"} it…`, 4000);
  try {
    const url = await upload(file, kind === "image" ? "images" : `${kind}s`, name);
    const r = kind === "image"
      ? await fn("see", { room, author: me, image_url: url, caption })
      : await fn("read-media", { room, author: me, kind, url, name, mime: file.type || null, size: file.size, caption });
    if (r?.event?.id) placeOnBoard({ kind: "event", data: { event_id: r.event.id }, w: kind === "file" ? 260 : 300 });
  } catch (e) {
    toast(`Couldn't share that ${SHARING[kind]}: ${e.message}`);
  } finally {
    $("sendStatus").textContent = "";
  }
}
const shareImage = (blob, caption = "") => shareFile(blob, "image", caption);

document.querySelectorAll("input.pick").forEach((inp) => (inp.onchange = (ev) => {
  const files = [...(ev.target.files || [])];
  const caption = (isMobile() ? $("mNote") : $("noteInput")).value.trim();
  files.forEach((f) => shareFile(f, inp.dataset.kind === "file" ? kindOf(f) : inp.dataset.kind, caption));
  ev.target.value = "";
  $("shareSheet").hidden = true;
  $("addMenu").hidden = true;
}));
document.querySelectorAll("[data-share]").forEach((b) => (b.onclick = () => {
  $("shareSheet").hidden = true;
  const kind = b.dataset.share;
  if (kind === "sketch") { setTab("board"); return startPen(); }
  if (kind === "voice") return startVoiceNote();
  $("mNote").placeholder = kind === "link" ? "Paste a link…" : "Type a note…";
  $("mNote").focus();
}));
$("plusBtn").onclick = () => ($("shareSheet").hidden = false);
$("sketchBtn").onclick = () => { setView("board"); startPen(); };
$("voiceNoteBtn").onclick = () => startVoiceNote();

document.addEventListener("paste", (ev) => {
  if (ev.target?.closest?.(".bit")) return;
  const files = [...(ev.clipboardData?.files || [])];
  if (!files.length) return;
  ev.preventDefault();
  files.forEach((f) => shareFile(f, kindOf(f), $("noteInput").value.trim()));
});
// Drop anything anywhere on the room
let dragDepth = 0;
window.addEventListener("dragenter", (ev) => { if ([...(ev.dataTransfer?.types || [])].includes("Files")) { dragDepth++; document.body.classList.add("dragging"); } });
window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("dragging"); } });
window.addEventListener("dragover", (ev) => ev.preventDefault());
window.addEventListener("drop", (ev) => {
  ev.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dragging");
  [...(ev.dataTransfer?.files || [])].forEach((f) => shareFile(f));
});

// ---------- voice notes: record, then Huddle transcribes and keeps the audio ----------
const rec = { on: false, stream: null, ctx: null, proc: null, frames: [], start: 0, timer: null };
const MAX_NOTE_MS = 3 * 60 * 1000;
async function startVoiceNote() {
  if (!me) return toast("Join the huddle first");
  if (rec.on) return;
  try {
    rec.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
  } catch (e) { return toast(`Mic unavailable: ${e.message}`); }
  try { rec.ctx = new AudioContext({ sampleRate: 16000 }); } catch { rec.ctx = new AudioContext(); }
  const src = rec.ctx.createMediaStreamSource(rec.stream);
  rec.proc = rec.ctx.createScriptProcessor(4096, 1, 1);
  rec.proc.onaudioprocess = (e) => { rec.frames.push(new Float32Array(e.inputBuffer.getChannelData(0))); e.outputBuffer.getChannelData(0).fill(0); };
  src.connect(rec.proc); rec.proc.connect(rec.ctx.destination);
  rec.on = true; rec.frames = []; rec.start = Date.now();
  $("recBar").hidden = false;
  const tick = () => {
    const ms = Date.now() - rec.start;
    $("recTime").textContent = `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
    if (ms >= MAX_NOTE_MS) stopVoiceNote(true);
  };
  tick();
  rec.timer = setInterval(tick, 500);
}
function stopVoiceNote(send) {
  if (!rec.on) return;
  clearInterval(rec.timer);
  rec.proc?.disconnect();
  rec.stream?.getTracks().forEach((t) => t.stop());
  const rate = rec.ctx?.sampleRate || 16000;
  rec.ctx?.close();
  rec.on = false;
  $("recBar").hidden = true;
  const frames = rec.frames; rec.frames = [];
  if (!send) return toast("Voice note discarded.");
  if (frames.length * 4096 / rate < 0.8) return toast("That was too short to share.");
  const blob = new Blob([encodeWav(frames, rate)], { type: "audio/wav" });
  shareFile(new File([blob], `voice-note-${Date.now()}.wav`, { type: "audio/wav" }), "voice");
}
$("recStop").onclick = () => stopVoiceNote(true);
$("recCancel").onclick = () => stopVoiceNote(false);

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
  $("brainMeta").hidden = view === "board";
  if (view === "board" && !ui.boardFitted) { ui.boardFitted = true; requestAnimationFrame(fitBoard); }
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
  // The admin's way into the operator room, where Huddle changes Huddle.
  const admins = String(config.ADMIN_LOGINS || "").toLowerCase().split(",");
  if (auth.user?.login && admins.includes(auth.user.login.toLowerCase()) && room !== config.OPERATOR_ROOM) {
    list.append(h("button", { class: "ritem", role: "menuitem", onclick: () => { location.href = `${location.pathname}?room=${encodeURIComponent(config.OPERATOR_ROOM)}`; } },
      h("span", { class: "rdot", "aria-hidden": "true" }, "⚙"),
      h("span", { class: "grow" }, "Operator", h("small", {}, "Improve Huddle itself: changes go to GitHub as pull requests"))));
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
// Anyone in the room can rename it; everyone sees the new name live.
function renderRoomName() {
  const name = roomLabel(room);
  $("roomName").textContent = name;
  document.title = `${name} · Huddle`;
  if (!$("join").hidden) $("joinRoom").textContent = name;
  const mine = myRooms.find((r) => r.id === room);
  if (mine && state.room?.name && mine.name !== state.room.name) {
    mine.name = state.room.name;
    store.set("huddle:rooms", JSON.stringify(myRooms.slice(0, 20)));
  }
}
// Click the room name to rename it in place. Enter or clicking away saves; Escape cancels.
function startRename() {
  if (!me) return toast("Join the huddle first");
  const inp = $("roomNameInput");
  inp.value = state.room?.name || myRooms.find((r) => r.id === room)?.name || "";
  inp.placeholder = "Name this huddle";
  $("roomNameBtn").hidden = true;
  inp.hidden = false;
  inp.focus();
  inp.select();
}
function endRename() {
  $("roomNameInput").hidden = true;
  $("roomNameBtn").hidden = false;
}
async function saveRoomName() {
  const inp = $("roomNameInput");
  if (inp.hidden) return;
  const name = inp.value.trim().replace(/\s+/g, " ").slice(0, 60);
  endRename();
  const before = state.room?.name ?? null;
  if (!name || name === roomLabel(room)) return;
  state.room = { ...(state.room || { id: room }), name };
  renderRoomName();
  const { error } = await sb.from("rooms").update({ name }).eq("id", room);
  if (error) {
    state.room = { ...state.room, name: before };
    renderRoomName();
    return toast(`Couldn't rename: ${error.message}`);
  }
  toast(`Renamed to “${name}”. Everyone in the room sees it now.`);
}
$("roomNameBtn").onclick = startRename;
$("roomNameInput").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") { ev.preventDefault(); saveRoomName(); }
  if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); endRename(); }
});
$("roomNameInput").addEventListener("blur", saveRoomName);
$("roomMenu").addEventListener("click", (ev) => ev.stopPropagation());

$("newRoomBtn").onclick = () => { $("roomMenu").hidden = true; $("newRoom").hidden = false; $("newName").focus(); };
$("createRoom").onclick = async () => {
  const id = Math.random().toString(36).slice(2, 8);
  const name = $("newName").value.trim().slice(0, 60) || "New huddle";
  myRooms.unshift({ id, name });
  store.set("huddle:rooms", JSON.stringify(myRooms.slice(0, 20)));
  store.set(`huddle:pendingName:${id}`, name);
  const link = `${location.origin}${location.pathname}?room=${id}`;
  try { await navigator.clipboard.writeText(link); } catch {}
  location.href = link;
};

// Private huddles aren't built yet: the switch explains that and collects interest.
function openUpgrade() {
  $("roomMenu").hidden = true;
  $("upEmail").hidden = false; $("upDone").hidden = true;
  $("upgrade").hidden = false;
  setTimeout(() => $("upEmailInput").focus(), 50);
}
// With GitHub sign-in configured, the switch really makes the huddle (and its repository) private.
async function toggleVisibility() {
  if (!config.GITHUB_SIGNIN) return openUpgrade();
  // Org-backed rooms only need you to sign in (to own the room); personal repos also need private-repo access.
  if (!auth.token) return signIn(config.GITHUB_ORG ? "" : "private");
  const to = state.room?.visibility === "private" ? "public" : "private";
  try {
    let r = await fn("github", { room, action: "visibility", visibility: to });
    if (r.need_scope) return signIn("private");
    if (r.confirm_public) {
      if (!confirm(`Making this huddle public also makes github.com/${r.repo.owner}/${r.repo.name} public. Anything in it can then be copied by anyone. Continue?`)) return;
      r = await fn("github", { room, action: "visibility", visibility: to, confirm_public: true });
    }
    state.room = { ...(state.room || { id: room }), visibility: r.visibility };
    renderVisibility();
    toast(r.visibility === "private" ? "Private: only you and people you invite (by GitHub username) can open this huddle." : "Public: anyone with the link can join.");
  } catch (e) { toast(e.message); }
}
function renderVisibility() {
  const priv = state.room?.visibility === "private";
  for (const id of ["visSwitch", "visSwitch2"]) {
    $(id).classList.toggle("on", priv);
    $(id).setAttribute("aria-checked", String(priv));
    $(id).title = priv ? "Private: only invited GitHub users can open it" : "Public: anyone with the link can join";
  }
}
$("visSwitch").onclick = toggleVisibility;
$("newVis").onclick = openUpgrade;
$("visSwitch2").onclick = toggleVisibility;

// ---------- GitHub: sign in, back the room with a repository, publish ----------
function renderGhButton() {
  if (!config.GITHUB_SIGNIN && !config.GITHUB_ORG) return;
  const priv = state.room?.visibility === "private";
  $("ghBtn").hidden = false;
  $("ghLabel").textContent = state.room?.repo?.self ? "Huddle repo" : state.room?.repo ? (priv ? "Private repo" : "Public repo")
    : config.GITHUB_ORG && !priv ? "Save to GitHub" : !auth.token ? "Sign in with GitHub" : "Publish to GitHub";
  $("ghBtn").title = state.room?.repo ? `github.com/${state.room.repo.owner}/${state.room.repo.name}` : "Back this huddle with its own GitHub repository";
}
async function openGitHub() {
  const body = $("ghBody");
  body.innerHTML = "";
  $("gh").hidden = false;
  const orgPublic = config.GITHUB_ORG && state.room?.visibility !== "private";
  if (!auth.token && !orgPublic) {
    body.append(h("p", {}, "Sign in with GitHub to back this huddle with its own repository. Huddle writes the brief, decisions, research and the code it built there, with secrets removed."),
      h("p", { class: "muted small" }, "Repositories are public unless you turn on Private. Huddle asks for access to private repositories only when you do."),
      h("div", { class: "crow" }, h("button", { class: "btn pri", onclick: () => signIn() }, "Sign in with GitHub")));
    return;
  }
  body.append(auth.token
    ? h("p", { class: "muted small" }, `Signed in as @${auth.user?.login}. `,
      h("button", { class: "link", onclick: () => { store.del("huddle:token"); store.del("huddle:user"); location.reload(); } }, "Sign out"))
    : h("p", { class: "muted small" }, `This huddle is public, so Huddle saves its brief, research and builds to the ${config.GITHUB_ORG} organization on GitHub as it works. No sign-in needed. `,
      h("button", { class: "link", onclick: () => signIn() }, "Sign in"), " to make it private."));
  const wait = h("p", { class: "muted" }, "Loading…");
  body.append(wait);
  let st;
  try { st = await fn("github", { room, action: "status" }); } catch (e) { wait.textContent = e.message; return; }
  wait.remove();
  if (st.self) {
    body.append(h("p", {}, "This is the operator room. It's connected to Huddle's own code: ",
      h("a", { href: st.repo.html_url, target: "_blank", rel: "noopener" }, `github.com/${st.repo.owner}/${st.repo.name}`), ` (branch ${st.repo.branch}).`),
      h("p", { class: "muted small" }, "Ask for a change in the room. Huddle edits its prompts, type-checks them in Daytona, has the change reviewed, and opens a pull request. CI runs the evals on it; in Full auto Huddle merges it when they pass, which deploys it. Otherwise you merge it."),
      st.is_owner ? h("p", { class: "hint" }, "Members can ask for changes to Huddle; their pull requests open under your GitHub account, so invite only people you trust with that.") : null);
  }
  const priv = st.visibility === "private";
  if (!st.self) body.append(h("p", {},
    st.repo ? h("span", {}, "Backed by ", h("a", { href: st.repo.html_url, target: "_blank", rel: "noopener" }, `github.com/${st.repo.owner}/${st.repo.name}`),
      st.repo.pages_url ? h("span", {}, " · ", h("a", { href: st.repo.pages_url, target: "_blank", rel: "noopener" }, "GitHub Pages")) : null)
      : st.org_mode && !priv ? `Not saved yet. The first finished research or build creates github.com/${st.org}/<name>-${room}, or save now.`
      : "Not backed by a repository yet. Publishing creates one in your account from the Huddle template.",
    h("br"), h("span", { class: "muted small" },
      `${priv ? "Private" : "Public"} · ${st.owner ? `owner @${st.owner.login}` : "no owner yet (publishing makes you the owner)"}`)));
  const canEdit = (st.org_mode && !priv) || st.is_owner || !st.owner;
  if (priv) {
    body.append(h("p", { class: "lab" }, "Members"), h("p", { class: "small" }, (st.members || []).map((m) => `@${m.login}${m.role === "owner" ? " (owner)" : m.user_id ? "" : " (invited)"}`).join(", ") || "Only you"));
    if (st.is_owner) {
      const inp = h("input", { class: "inp", placeholder: "GitHub username", "aria-label": "GitHub username to invite" });
      body.append(h("div", { class: "crow" }, inp, h("button", { class: "btn ghost sm", onclick: async () => {
        try { const r = await fn("github", { room, action: "invite", login: inp.value }); toast(`Invited @${r.invited}. They sign in with GitHub to open this huddle.`); openGitHub(); }
        catch (e) { toast(e.message); }
      } }, "Invite")));
    }
  }
  if (st.self) return; // the operator room ships through pull requests, not publishing
  if (!canEdit) { body.append(h("p", { class: "muted small" }, `Only @${st.owner.login} can publish this huddle.`)); return; }
  const name = h("input", { class: "inp", value: st.repo?.name || (state.room?.name || `huddle-${room}`).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), "aria-label": "Repository name", disabled: !!st.repo || st.org_mode });
  const tr = h("input", { type: "checkbox", id: "ghTranscript" });
  const out = h("div", { class: "ghfiles" });
  const pub = h("button", { class: "btn pri", disabled: true }, "Publish");
  const opts = () => ({ room, transcript: tr.checked, name: name.value });
  const preview = async () => {
    out.textContent = "Checking for secrets (patterns, then gitleaks in a Daytona sandbox)…";
    pub.disabled = true;
    try {
      const r = await fn("github", { ...opts(), action: "preview" });
      const n = r.files.filter((f) => f.changed).length;
      out.innerHTML = "";
      out.append(h("p", { class: "small" }, `${n} of ${r.files.length} files will be written to `, h("b", {}, `github.com/${r.target.owner}/${r.target.name}`),
        ` (${r.target.private ? "private" : "public"}). ${r.note}.`),
        r.findings.length ? h("p", { class: "small warn" }, `Redacted ${r.findings.length} secret${r.findings.length > 1 ? "s" : ""}: ${[...new Set(r.findings.map((f) => `${f.rule} in ${f.file}`))].join(", ")}`) : null,
        h("ul", { class: "files" }, ...r.files.map((f) => h("li", { class: f.changed ? "" : "muted" }, `${f.path} · ${f.bytes.toLocaleString()} chars${f.changed ? "" : " · unchanged"}`))));
      pub.disabled = !n;
      pub.textContent = n ? `Publish ${n} file${n > 1 ? "s" : ""}` : "Up to date";
    } catch (e) { out.textContent = e.message; }
  };
  pub.onclick = async () => {
    pub.disabled = true; pub.textContent = "Publishing…";
    try {
      const r = await fn("github", { ...opts(), action: "publish" });
      if (r.up_to_date) { toast("Already up to date."); return openGitHub(); }
      toast(`Published ${r.changed.length} files.`);
      out.innerHTML = "";
      out.append(h("p", {}, "Published: ", h("a", { href: r.html_url, target: "_blank", rel: "noopener" }, `commit ${r.commit.slice(0, 7)}`), " in ",
        h("a", { href: r.repo.html_url, target: "_blank", rel: "noopener" }, `${r.repo.owner}/${r.repo.name}`)));
      state.room = { ...(state.room || { id: room }), repo: r.repo };
      renderGhButton();
    } catch (e) { toast(e.message); pub.disabled = false; pub.textContent = "Publish"; }
  };
  tr.onchange = preview;
  body.append(h("p", { class: "lab" }, "Repository"), name,
    h("label", { class: "small crow", for: "ghTranscript", style: "margin-top:8px" }, tr, "Include the transcript (speech and notes older than 2 minutes)"),
    out, h("div", { class: "crow", style: "margin-top:10px" }, h("button", { class: "btn ghost", onclick: preview }, "Preview again"), pub));
  preview();
}
$("ghBtn").onclick = openGitHub;
function notifyMe() {
  const em = $("upEmailInput").value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return toast("Please enter a valid email.");
  $("upNotify").disabled = true;
  sb.from("waitlist").insert({ email: em, room_id: room }).then(({ error }) => {
    $("upNotify").disabled = false;
    if (error) return toast(`Couldn't save your email: ${error.message}`);
    $("upDoneEmail").textContent = em;
    $("upEmail").hidden = true; $("upDone").hidden = false;
  });
}
$("upNotify").onclick = notifyMe;
$("upEmailInput").addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); notifyMe(); } });

// ---------- invite + connect your AI ----------
$("shareBtn").onclick = async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    toast(state.room?.visibility === "private"
      ? "Invite link copied. This huddle is private: invite people by GitHub username under GitHub."
      : "Invite link copied. This huddle is public, so anyone with the link can join.");
  } catch {
    prompt("Copy this link", location.href);
  }
};
function openConnect() {
  const get = `curl "${FN_BASE}/brain-api?room=${room}"`;
  const post = `curl -X POST "${FN_BASE}/brain-api" -H "content-type: application/json" \\\n  -d '{"room":"${room}","author":"${me || "my-claude"}","text":"<finding>"}'`;
  $("curlGet").textContent = get;
  $("curlPost").textContent = post;
  renderMcp(`${location.origin}/mcp?room=${encodeURIComponent(room)}`);
  $("aiPrompt").textContent =
    `You are helping my team in a Huddle room.\nBefore you work, read our living brief:\n${get}\n\nWhen you find something useful, post it back to the room as a finding, with sources:\n${post}`;
  $("connect").hidden = false;
}
// Huddle MCP: the room's link (public rooms), or a personal revocable link with chosen permissions.
function renderMcp(url) {
  $("mcpUrl").textContent = url;
  $("mcpCmd").textContent = `claude mcp add --transport http huddle "${url}"`;
  const priv = state.room?.visibility === "private";
  if (priv) $("mcpNote").textContent = "This huddle is private: make a personal link to connect an AI. You can revoke it any time. Keys are never sent through it.";
  const mine = store.json(`huddle:mcp:${room}`, []);
  const list = $("mcpMine");
  list.innerHTML = "";
  for (const l of mine) {
    list.append(h("div", { class: "crow small", style: "margin-top:6px" },
      h("code", { class: "grow", style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, l.url),
      h("button", { class: "btn ghost sm", onclick: async () => { try { await navigator.clipboard.writeText(`claude mcp add --transport http huddle "${l.url}"`); toast("Copied the Claude Code command."); } catch {} } }, "Copy"),
      h("button", { class: "btn ghost sm", onclick: async () => {
        await fetch(`/mcp/links?key=${encodeURIComponent(l.key)}`, { method: "DELETE" });
        store.set(`huddle:mcp:${room}`, JSON.stringify(mine.filter((x) => x.key !== l.key)));
        toast("Link revoked."); renderMcp(url);
      } }, "Revoke")));
  }
}
$("mcpMake").onclick = async () => {
  try {
    const r = await (await fetch("/mcp/links", {
      method: "POST", headers: { "content-type": "application/json", ...(auth.token ? { authorization: `Bearer ${auth.token}` } : {}) },
      body: JSON.stringify({ room, label: me || null, perms: { post: true, work: $("mcpWork").checked, answer: $("mcpAnswer").checked } }),
    })).json();
    if (r.error) return toast(r.error);
    const url = `${r.url}${me ? `&as=${encodeURIComponent(me)}` : ""}`;
    const mine = store.json(`huddle:mcp:${room}`, []);
    store.set(`huddle:mcp:${room}`, JSON.stringify([{ url, key: r.key }, ...mine].slice(0, 5)));
    try { await navigator.clipboard.writeText(`claude mcp add --transport http huddle "${url}"`); } catch {}
    toast("Your link is ready, and the Claude Code command is copied.");
    renderMcp(`${location.origin}/mcp?room=${encodeURIComponent(room)}`);
  } catch (e) { toast(e.message); }
};
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
  silenceMs: 0, speechMs: 0, noise: 0.008 };

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
    : mic.speaking ? "Listening…" : "Mic on";
  $("forgetBtn").hidden = !(mic.on || Date.now() - lastSpokeAt < 120_000);
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
  if (mic.recog) return setMicLabel();
  if (!frames.length || (!force && speechMs < 500)) return setMicLabel();
  const wav = encodeWav(frames, mic.ctx.sampleRate);
  inflight++;
  setMicLabel();
  try {
    await fn("transcribe", { room, author: me, audio: b64(wav) });
    lastSpokeAt = Date.now();
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
  if (config.SPEECH === "browser") startBrowserSpeech();
  roomChannel?.track({ name: me, clientId, mic: true });
  setMicLabel();
  toast("Mic on. Huddle is listening.");
}
// Without a server speech model (AWS/Bedrock deploy), use the browser's own speech recognition.
function startBrowserSpeech() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return toast("This browser can't transcribe speech; try Chrome, Edge or Safari", 6000);
  const r = new SR();
  r.continuous = true;
  r.interimResults = false;
  r.lang = navigator.language || "en-US";
  r.onresult = async (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const text = e.results[i].isFinal && e.results[i][0].transcript.trim();
      if (!text) continue;
      inflight++; setMicLabel();
      try { await fn("transcribe", { room, author: me, text }); lastSpokeAt = Date.now(); }
      catch (err) { toast(`Transcription failed: ${err.message}`); }
      finally { inflight--; setMicLabel(); }
    }
  };
  r.onend = () => { if (mic.recog === r) try { r.start(); } catch { /* already restarting */ } };
  mic.recog = r;
  r.start();
}
function stopMic() {
  const r = mic.recog;
  mic.recog = null;
  r?.stop();
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

// "Forget last 2 min": erase what you said (live speech and voice notes) in the last two minutes.
let lastSpokeAt = 0;
$("forgetBtn").onclick = async () => {
  try {
    const r = await fn("forget", { room, author: me, minutes: 2 });
    const n = r?.forgotten?.length || 0;
    for (const id of r?.forgotten || []) { const e = state.events.get(id); if (e) Object.assign(e, { forgotten: true, text: null }); }
    renderStream(); renderBoard();
    toast(n ? `Erased ${n} ${n === 1 ? "thing" : "things"} you said in the last 2 minutes.` : "Nothing to erase from the last 2 minutes.");
  } catch (e) { toast(`Couldn't erase: ${e.message}`); }
};
setInterval(setMicLabel, 15000);

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
    wrap.append(h("span", { class: `pav${p.mic ? " mic" : ""}${p.ai ? " ai" : ""}`, style: `background:${colorFor(p.name)}`,
      title: `${p.name}${p.ai ? " · AI connected over MCP" : ""}${p.you ? " (you)" : ""}${p.mic ? " · mic on" : ""}${p.tabs > 1 ? ` · ${p.tabs} tabs` : ""}` }, p.ai ? "AI" : p.name.slice(0, 1).toUpperCase()));
  }
  const here = $("hereCount");
  here.textContent = `${seen.size} here`;
  here.hidden = !seen.size;
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
  const board = await sb.from("board_items").select("*").eq("room_id", room).eq("removed", false).order("id");
  (board.data || []).forEach((b) => state.board.set(b.id, b));
  // Board cards can point at older events than the 200 we load; fetch those too.
  const missing = (board.data || []).filter((b) => b.kind === "event").map((b) => Number(b.data?.event_id)).filter((id) => id && !(ev.data || []).some((e) => e.id === id));
  if (missing.length) {
    const more = await sb.from("events").select("*").in("id", missing);
    (more.data || []).forEach((e) => state.events.set(e.id, e));
  }
  if (ev.error) toast(`Can't reach the server: ${ev.error.message}`, 6000);
  (ev.data || []).forEach((e) => state.events.set(e.id, e));
  (jobs.data || []).forEach((j) => state.jobs.set(j.id, j));
  (pipes.data || []).forEach((p) => state.pipelines.set(p.id, p));
  state.brain = brain.data;
  state.room = roomRow.data;
  // A huddle you just created gets the name you gave it, shared with everyone.
  const pendingName = store.get(`huddle:pendingName:${room}`);
  if (pendingName) {
    store.del(`huddle:pendingName:${room}`);
    if (!state.room?.name) {
      const { error } = await sb.from("rooms").update({ name: pendingName }).eq("id", room);
      if (!error) state.room = { ...(state.room || { id: room }), name: pendingName };
    }
  }
  renderRoomName();
  renderVisibility();
  renderGhButton();
  renderAll();
  // Start at the newest input (again after images load, which changes the height).
  const toBottom = () => { const l = $("events"); l.scrollTop = l.scrollHeight; };
  requestAnimationFrame(() => requestAnimationFrame(toBottom));
  setTimeout(toBottom, 600);
}

function subscribe() {
  sb.channel(`db-${room}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "events", filter: `room_id=eq.${room}` },
      ({ new: e }) => { if (!e?.id) return; state.events.set(e.id, e); renderStream(); renderBoard(); })
    .on("postgres_changes", { event: "*", schema: "public", table: "board_items", filter: `room_id=eq.${room}` },
      ({ new: b }) => { if (!b?.id) return; state.board.set(b.id, b); renderBoard(); })
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
      ({ new: r }) => { const renamed = r.name && r.name !== state.room?.name; state.room = r; renderWork(); renderRoomName(); if (renamed) toast(`This huddle is now called “${r.name}”.`); })
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
  // A private huddle you aren't in: the room row is hidden from you (RLS), so say why.
  const { data: visible } = await sb.from("rooms").select("id").eq("id", room).maybeSingle();
  if (!visible && config.GITHUB_SIGNIN && (await roomExists())) return privateGate();
  if (!me) { $("join").hidden = false; renderJoinInfo(); }
  await loadInitial();
  subscribe();
  if (!me) $("joinName").focus();
  else afterJoin();
}

// Does a room with this id exist at all (even if it's hidden from us)? Creating it would fail if so.
async function roomExists() {
  const { error } = await sb.from("rooms").insert({ id: room });
  return !!error; // no error: we just created it, so it didn't exist

}
function privateGate() {
  $("gh").hidden = false;
  const body = $("ghBody");
  body.innerHTML = "";
  body.append(h("h3", {}, "This huddle is private"),
    auth.token
      ? h("p", {}, `You're signed in as @${auth.user?.login}, who isn't a member. Ask the owner to invite @${auth.user?.login} under GitHub → Members, then reload.`)
      : h("p", {}, "Only invited GitHub users can open it. Sign in with the GitHub account you were invited with."),
    h("div", { class: "crow" }, auth.token
      ? h("button", { class: "btn ghost", onclick: () => { store.del("huddle:token"); store.del("huddle:user"); location.reload(); } }, "Use another account")
      : h("button", { class: "btn pri", onclick: () => signIn() }, "Sign in with GitHub")));
}

setView("brief");
setMicLabel();
if (SUPABASE_URL.includes("YOUR-PROJECT")) {
  toast("Set SUPABASE_URL and SUPABASE_KEY in web/config.js", 10000);
} else {
  start();
}
