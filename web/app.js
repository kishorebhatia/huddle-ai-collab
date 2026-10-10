import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { marked } from "https://esm.sh/marked@12.0.2";
import DOMPurify from "https://esm.sh/dompurify@3.1.6";
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const $ = (id) => document.getElementById(id);
const FN_BASE = `${SUPABASE_URL}/functions/v1`;

// ---------- identity & room ----------
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
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
$("roomName").textContent = `room ${room}`;

const COLORS = ["#2563eb", "#db2777", "#16a34a", "#d97706", "#7c3aed", "#0891b2", "#dc2626"];
const colorFor = (name) => {
  let h = 0;
  for (const c of name || "?") h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return name === "huddle" ? "#6b7280" : COLORS[h % COLORS.length];
};
const md = (s) => DOMPurify.sanitize(marked.parse(s || ""));
const timeAgo = (iso) => {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.max(s, 0)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
};

function toast(msg, ms = 2500) {
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
const state = { events: new Map(), jobs: new Map(), brain: null, peers: [] };

// ---------- live feed ----------
const KIND_LABEL = { speech: "said", note: "note", link: "link", image: "board", finding: "finding", feedback: "feedback", system: "agent" };

function renderEvent(e) {
  let li = document.getElementById(`ev-${e.id}`);
  const isNew = !li;
  if (!li) {
    li = document.createElement("li");
    li.id = `ev-${e.id}`;
  }
  li.className = `ev kind-${e.kind}`;
  li.innerHTML = "";
  const head = document.createElement("div");
  head.className = "ev-head";
  const av = document.createElement("span");
  av.className = "avatar";
  av.style.background = colorFor(e.author);
  av.textContent = (e.author || "?").slice(0, 1).toUpperCase();
  const name = document.createElement("strong");
  name.textContent = e.author;
  const kind = document.createElement("span");
  kind.className = "kind";
  kind.textContent = KIND_LABEL[e.kind] || e.kind;
  const meta = document.createElement("span");
  meta.className = "muted small";
  meta.textContent = `#${e.id} · ${timeAgo(e.created_at)}`;
  head.append(av, name, kind, meta);
  li.append(head);

  if (e.image_url) {
    const img = document.createElement("img");
    img.src = e.image_url;
    img.alt = "shared image";
    img.loading = "lazy";
    img.onclick = () => window.open(e.image_url, "_blank");
    li.append(img);
  }
  const body = document.createElement("div");
  body.className = "ev-body";
  if (e.kind === "speech" || e.kind === "note" || e.kind === "system") body.textContent = e.text || "";
  else body.innerHTML = md(e.text);
  li.append(body);

  const list = $("events");
  if (isNew) {
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    list.append(li);
    if (atBottom) list.scrollTop = list.scrollHeight;
  }
  $("feedCount").textContent = `${state.events.size} items`;
}

function jumpTo(id) {
  const el = document.getElementById(`ev-${id}`);
  if (!el) return toast(`#${id} is older than what's loaded`);
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("flash");
  setTimeout(() => el.classList.remove("flash"), 1600);
  if (matchMedia("(max-width: 900px)").matches) showCol("feed");
}

// ---------- brain ----------
function renderBrain() {
  const b = state.brain;
  const s = b?.state || {};
  const has = s.goal || s.summary;
  $("brainEmpty").hidden = !!has;
  $("brain").hidden = !has;
  $("brainMeta").textContent = b?.version ? `v${b.version} · updated ${timeAgo(b.updated_at)}` : "";
  if (!has) return;
  $("bGoal").textContent = s.goal || "";
  $("bSummary").textContent = s.summary || "";
  const ch = $("bChanged");
  ch.innerHTML = "";
  (s.changed || []).forEach((c) => {
    const span = document.createElement("span");
    span.className = "chg";
    span.textContent = c;
    ch.append(span);
  });
  const fill = (id, items = [], extra) => {
    const ul = $(id);
    ul.innerHTML = "";
    if (!items.length) {
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = "—";
      ul.append(li);
    }
    items.forEach((it) => {
      const li = document.createElement("li");
      if (extra) extra(li, it);
      const t = document.createElement("span");
      t.textContent = it.text;
      li.append(t);
      if (it.by || it.owner) {
        const who = document.createElement("span");
        who.className = "who";
        who.textContent = it.owner || it.by;
        li.append(who);
      }
      (it.refs || []).slice(0, 4).forEach((r) => {
        const a = document.createElement("button");
        a.className = "ref";
        a.textContent = `#${r}`;
        a.onclick = () => jumpTo(r);
        li.append(a);
      });
      ul.append(li);
    });
  };
  fill("bDecisions", s.decisions);
  fill("bQuestions", s.questions);
  fill("bIdeas", s.ideas);
  fill("bNext", s.next_steps, (li, it) => {
    const tag = document.createElement("span");
    tag.className = `badge t-${it.type || "todo"}`;
    tag.textContent = it.type || "todo";
    li.append(tag);
  });
}
setInterval(renderBrain, 15000);

let synthBusy = false;
async function synthesize(force = false) {
  if (synthBusy) return;
  synthBusy = true;
  $("synthBtn").textContent = "Synthesizing…";
  try {
    const r = await fn("synthesize", { room, force });
    if (r?.proposed) toast(`Huddle proposed ${r.proposed} agent job${r.proposed > 1 ? "s" : ""}`);
  } catch (e) {
    console.error(e);
    if (force) toast(`Synthesis failed: ${e.message}`);
  } finally {
    synthBusy = false;
    $("synthBtn").textContent = "Synthesize now";
  }
}
$("synthBtn").onclick = () => synthesize(true);

// One browser (the "leader", lowest presence id) runs synthesis on a timer so we don't triple-bill.
setInterval(() => {
  const ids = state.peers.map((p) => p.clientId).sort();
  if (ids[0] === clientId) synthesize(false);
}, 45000);

// ---------- jobs & outputs ----------
const STATUS_LABEL = { proposed: "proposed", running: "running…", done: "done", failed: "failed", dismissed: "dismissed" };

function renderJobs() {
  const wrap = $("jobs");
  wrap.innerHTML = "";
  const jobs = [...state.jobs.values()].filter((j) => j.status !== "dismissed").sort((a, b) => {
    const order = { proposed: 0, running: 1, failed: 2, done: 3 };
    return (order[a.status] - order[b.status]) || (b.id - a.id);
  });
  if (!jobs.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "Research and prototype jobs appear here — proposed by the brain or asked for above. Outputs open in place.";
    wrap.append(p);
  }
  for (const j of jobs) {
    const card = document.createElement("div");
    card.className = `job s-${j.status}`;
    const top = document.createElement("div");
    top.className = "job-top";
    const kind = document.createElement("span");
    kind.className = `badge t-${j.kind}`;
    kind.textContent = j.kind;
    const st = document.createElement("span");
    st.className = `status s-${j.status}`;
    st.textContent = STATUS_LABEL[j.status];
    const by = document.createElement("span");
    by.className = "muted small";
    by.textContent = `#${j.id} · ${j.created_by}`;
    top.append(kind, st, by);
    const title = document.createElement("div");
    title.className = "job-title";
    title.textContent = j.title;
    card.append(top, title);

    if (j.status === "done" && j.kind === "prototype") {
      const frame = document.createElement("iframe");
      frame.className = "thumb";
      frame.setAttribute("sandbox", "allow-scripts");
      frame.srcdoc = j.output_html || "";
      frame.tabIndex = -1;
      card.append(frame);
    }
    if (j.status === "done" && j.output_md) {
      const p = document.createElement("p");
      p.className = "job-preview";
      p.textContent = j.output_md.replace(/[#*_>`]/g, "").slice(0, 220);
      card.append(p);
    }
    if (j.status === "failed" && j.error) {
      const p = document.createElement("p");
      p.className = "job-error";
      p.textContent = j.error;
      card.append(p);
    }

    const row = document.createElement("div");
    row.className = "job-actions";
    const btn = (label, cls, onclick) => {
      const b = document.createElement("button");
      b.className = `btn small ${cls}`;
      b.textContent = label;
      b.onclick = onclick;
      row.append(b);
    };
    if (j.status === "proposed") {
      btn("Run", "primary", () => runJob(j.id));
      btn("Dismiss", "ghost", () => sb.from("jobs").update({ status: "dismissed" }).eq("id", j.id));
      const det = document.createElement("details");
      const sum = document.createElement("summary");
      sum.textContent = "prompt";
      const pre = document.createElement("p");
      pre.className = "small";
      pre.textContent = j.prompt;
      det.append(sum, pre);
      card.append(det);
    }
    if (j.status === "running") {
      const sp = document.createElement("span");
      sp.className = "spinner";
      row.append(sp);
    }
    if (j.status === "done") btn("Open", "primary", () => openViewer(j.id));
    if (j.status === "failed") btn("Retry", "ghost", () => runJob(j.id));
    card.append(row);
    wrap.append(card);
  }
}

async function runJob(id) {
  try {
    await fn("run-job", { job_id: id });
  } catch (e) {
    toast(`Could not start job: ${e.message}`);
  }
}

$("newJob").onsubmit = async (ev) => {
  ev.preventDefault();
  const text = $("jobPrompt").value.trim();
  if (!text) return;
  const kind = $("jobKind").value;
  $("jobPrompt").value = "";
  const { data, error } = await sb.from("jobs")
    .insert({ room_id: room, kind, title: text.slice(0, 90), prompt: text, created_by: me, status: "proposed" })
    .select().single();
  if (error) return toast(error.message);
  runJob(data.id);
};

let viewing = null;
let blobUrl = null;
function openViewer(id) {
  const j = state.jobs.get(id);
  if (!j) return;
  viewing = id;
  $("vKind").textContent = j.kind;
  $("vKind").className = `badge t-${j.kind}`;
  $("vTitle").textContent = j.title;
  const body = $("vBody");
  body.innerHTML = "";
  if (blobUrl) URL.revokeObjectURL(blobUrl);
  blobUrl = null;
  if (j.kind === "prototype") {
    const frame = document.createElement("iframe");
    frame.className = "proto";
    frame.setAttribute("sandbox", "allow-scripts allow-forms allow-modals");
    frame.srcdoc = j.output_html || "";
    body.append(frame);
    if (j.output_md) {
      const p = document.createElement("p");
      p.className = "muted small";
      p.textContent = j.output_md;
      body.append(p);
    }
    blobUrl = URL.createObjectURL(new Blob([j.output_html || ""], { type: "text/html" }));
    $("vOpen").hidden = false;
  } else {
    const art = document.createElement("article");
    art.className = "prose";
    art.innerHTML = md(j.output_md);
    body.append(art);
    if (j.sources?.length) {
      const h = document.createElement("h4");
      h.textContent = "Sources";
      const ul = document.createElement("ul");
      ul.className = "sources";
      j.sources.forEach((s) => {
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.href = s.url;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = s.title;
        li.append(a);
        ul.append(li);
      });
      body.append(h, ul);
    }
    $("vOpen").hidden = true;
  }
  $("viewer").hidden = false;
}
$("vOpen").onclick = () => blobUrl && window.open(blobUrl, "_blank");
$("vClose").onclick = () => ($("viewer").hidden = true);
$("vFeedback").onsubmit = async (ev) => {
  ev.preventDefault();
  const text = $("vFeedbackInput").value.trim();
  const parent = state.jobs.get(viewing);
  if (!text || !parent) return;
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
  toast("Revising…");
};

// ---------- composer: notes, links, images ----------
async function postNote(text) {
  const kind = /^https?:\/\/\S+$/.test(text) ? "link" : "note";
  const { error } = await sb.from("events").insert({ room_id: room, author: me, kind, text });
  if (error) toast(error.message);
}
$("composer").onsubmit = (ev) => {
  ev.preventDefault();
  const t = $("noteInput").value.trim();
  if (!t) return;
  $("noteInput").value = "";
  postNote(t);
};
$("noteInput").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault();
    $("composer").requestSubmit();
  }
});

async function shareImage(blob, caption = "") {
  $("sendStatus").textContent = "Reading image…";
  try {
    const ext = (blob.type.split("/")[1] || "png").replace("jpeg", "jpg");
    const path = `${room}/${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
    const up = await sb.storage.from("board").upload(path, blob, { contentType: blob.type || "image/png" });
    if (up.error) throw up.error;
    const { data } = sb.storage.from("board").getPublicUrl(path);
    await fn("see", { room, author: me, image_url: data.publicUrl, caption });
    $("sendStatus").textContent = "";
  } catch (e) {
    $("sendStatus").textContent = "";
    toast(`Image failed: ${e.message}`);
  }
}
$("fileInput").onchange = (ev) => {
  const f = ev.target.files?.[0];
  if (f) shareImage(f, $("noteInput").value.trim());
  ev.target.value = "";
};
document.addEventListener("paste", (ev) => {
  const item = [...(ev.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
  if (!item) return;
  ev.preventDefault();
  shareImage(item.getAsFile(), $("noteInput").value.trim());
});

// ---------- shared whiteboard (strokes broadcast live) ----------
const canvas = $("board");
const ctx2d = canvas.getContext("2d");
let penColor = "#1f2937";
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
canvas.addEventListener("pointerdown", (ev) => {
  canvas.setPointerCapture(ev.pointerId);
  cur = [toCanvas(ev)];
});
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
  toast("Sent the board to the brain");
};

// ---------- view switching ----------
document.querySelectorAll(".seg button").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll(".seg button").forEach((x) => x.classList.toggle("on", x === b));
    document.querySelectorAll("#center .view").forEach((v) => (v.hidden = v.id !== b.dataset.view));
  };
});
function showCol(col) {
  document.querySelectorAll("#mobileTabs button").forEach((x) => x.classList.toggle("on", x.dataset.col === col));
  document.querySelectorAll(".col").forEach((c) => c.classList.toggle("show", c.id === col));
}
document.querySelectorAll("#mobileTabs button").forEach((b) => (b.onclick = () => showCol(b.dataset.col)));
showCol("feed");

// ---------- invite + connect your AI ----------
$("shareBtn").onclick = async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    toast("Invite link copied");
  } catch {
    prompt("Copy this link", location.href);
  }
};
$("connectBtn").onclick = () => {
  $("curlGet").textContent = `curl "${FN_BASE}/brain-api?room=${room}"`;
  $("curlPost").textContent =
    `curl -X POST "${FN_BASE}/brain-api" -H "content-type: application/json" \\\n  -d '{"room":"${room}","author":"${me || "my-claude"}","text":"<finding>"}'`;
  $("connect").hidden = false;
};
document.querySelectorAll("[data-close]").forEach((b) => (b.onclick = () => ($(b.dataset.close).hidden = true)));
document.querySelectorAll(".overlay").forEach((o) =>
  o.addEventListener("click", (ev) => { if (ev.target === o && o.id !== "join") o.hidden = true; }));

// ---------- microphone: on-device voice detection, Gemini transcription ----------
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
  $("micLabel").textContent = !mic.on ? "Mic off"
    : inflight ? "Transcribing…"
    : $("micMode").value === "ptt" ? (mic.pttDown ? "Listening…" : "Hold Space")
    : mic.speaking ? "Listening…" : "Mic on";
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
  $("micBtn").classList.add("live");
  $("micBtn").setAttribute("aria-pressed", "true");
  roomChannel?.track({ name: me, clientId, mic: true });
  setMicLabel();
}
function stopMic() {
  if (mic.frames.length) flush();
  mic.proc?.disconnect();
  mic.stream?.getTracks().forEach((t) => t.stop());
  mic.ctx?.close();
  mic.on = false;
  $("micBtn").classList.remove("live");
  $("micBtn").setAttribute("aria-pressed", "false");
  $("meterFill").style.width = "0%";
  roomChannel?.track({ name: me, clientId, mic: false });
  setMicLabel();
}
$("micBtn").onclick = async () => {
  try { mic.on ? stopMic() : await startMic(); }
  catch (e) { toast(`Mic unavailable: ${e.message}`); }
};
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

// ---------- presence ----------
function renderPeers() {
  const wrap = $("peers");
  wrap.innerHTML = "";
  for (const p of state.peers) {
    const s = document.createElement("span");
    s.className = `peer${p.mic ? " mic" : ""}`;
    s.style.background = colorFor(p.name);
    s.title = `${p.name}${p.clientId === clientId ? " (you)" : ""}${p.mic ? " · mic on" : ""}`;
    s.textContent = (p.name || "?").slice(0, 1).toUpperCase();
    wrap.append(s);
  }
}

// ---------- realtime ----------
let roomChannel = null;

async function loadInitial() {
  const [ev, jobs, brain] = await Promise.all([
    sb.from("events").select("*").eq("room_id", room).order("id", { ascending: false }).limit(200),
    sb.from("jobs").select("*").eq("room_id", room).order("id"),
    sb.from("brain").select("*").eq("room_id", room).maybeSingle(),
  ]);
  if (ev.error) toast(`Can't reach Supabase: ${ev.error.message}`, 6000);
  (ev.data || []).reverse().forEach((e) => { state.events.set(e.id, e); renderEvent(e); });
  $("events").scrollTop = $("events").scrollHeight;
  (jobs.data || []).forEach((j) => state.jobs.set(j.id, j));
  state.brain = brain.data;
  renderJobs();
  renderBrain();
}

function subscribe() {
  sb.channel(`db-${room}`)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "events", filter: `room_id=eq.${room}` },
      ({ new: e }) => { state.events.set(e.id, e); renderEvent(e); })
    .on("postgres_changes", { event: "*", schema: "public", table: "jobs", filter: `room_id=eq.${room}` },
      ({ new: j }) => {
        const prev = state.jobs.get(j.id);
        state.jobs.set(j.id, j);
        renderJobs();
        if (prev && prev.status !== "done" && j.status === "done") toast(`Ready: ${j.title}`);
      })
    .on("postgres_changes", { event: "*", schema: "public", table: "brain", filter: `room_id=eq.${room}` },
      ({ new: b }) => { state.brain = b; renderBrain(); })
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
      if (status === "SUBSCRIBED") roomChannel.track({ name: me, clientId, mic: false });
    });
}

async function start() {
  await loadInitial();
  subscribe();
}

if (SUPABASE_URL.includes("YOUR-PROJECT")) {
  toast("Set SUPABASE_URL and SUPABASE_KEY in web/config.js", 10000);
} else if (!me) {
  $("join").hidden = false;
  $("joinName").focus();
  $("joinForm").onsubmit = (ev) => {
    ev.preventDefault();
    me = $("joinName").value.trim().slice(0, 30) || "guest";
    store.set("huddle:name", me);
    $("join").hidden = true;
    start();
  };
} else {
  start();
}
