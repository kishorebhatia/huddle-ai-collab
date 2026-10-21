// POST { room, author, kind: 'voice'|'video'|'file', url, name?, mime?, size?, caption? }
// -> Gemini listens to / watches / reads the upload and inserts one event the brief can use.
import { background, cors, db, FAST_MODEL, geminiJson, json, toBase64 } from "../_shared/util.ts";
import { withFileKey } from "../_shared/auth.ts";
import { invokeFn } from "../_shared/pipeline.ts";

// Inline uploads to Gemini are capped around 20 MB per request.
const MAX_INLINE = 18 * 1024 * 1024;

// File types Gemini can read directly. Others are still shared, just not read.
const READABLE = /^(application\/pdf|text\/|audio\/|video\/|image\/|application\/json)/;

const PROMPTS: Record<string, string> = {
  voice:
    "A teammate recorded this voice note for their team's shared workspace. Transcribe it verbatim in the " +
    "language spoken (clean up only obvious stutters). Then give a one-line title. If there is no " +
    "intelligible speech, set transcript to an empty string. Never guess words.",
  video:
    "A teammate shared this video in a live team brainstorm. Write concise markdown notes: what it shows, " +
    "any speech (quoted closely), any text on screen copied exactly, and the ideas or decisions it implies. " +
    "Give it a short title.",
  file:
    "A teammate shared this file in a live team brainstorm. Write concise markdown notes with the key points, " +
    "numbers and names copied exactly, and anything the team should decide or act on. Give it a short title.",
};

type Out = { title: string; notes?: string; transcript?: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { room, author, kind, url, name, mime: mimeIn, size, caption } = await req.json().catch(() => ({}));
    if (!room || !url || !["voice", "video", "file"].includes(kind)) {
      return json({ error: "room, url and kind (voice | video | file) required" }, 400);
    }
    const who = author ?? "someone";
    const meta: Record<string, unknown> = { url, name: name ?? null, mime: mimeIn ?? null, size: size ?? null };
    if (caption) meta.caption = caption;

    let text = "";
    let readable = true;
    const res = await fetch(await withFileKey(url, String(room)));
    if (!res.ok) throw new Error(`could not fetch upload: ${res.status}`);
    const mime = (mimeIn || res.headers.get("content-type") || "application/octet-stream").split(";")[0];
    const buf = await res.arrayBuffer();

    if (buf.byteLength > MAX_INLINE) {
      readable = false;
      text = `**${name ?? "Upload"}**\n\nShared, but too large for Huddle to read yet (over 18 MB).`;
    } else if (!READABLE.test(mime)) {
      readable = false;
      text = `**${name ?? "Upload"}**\n\nShared. Huddle can't read this file type yet; try a PDF or text file.`;
    } else {
      const isVoice = kind === "voice";
      const out = await geminiJson<Out>(
        [
          { inline_data: { mime_type: mime, data: toBase64(buf) } },
          { text: PROMPTS[kind] + (caption ? `\nTheir caption: ${caption}` : "") + (name ? `\nFile name: ${name}` : "") },
        ],
        {
          type: "OBJECT",
          properties: isVoice
            ? { title: { type: "STRING" }, transcript: { type: "STRING" } }
            : { title: { type: "STRING" }, notes: { type: "STRING" } },
          required: isVoice ? ["title", "transcript"] : ["title", "notes"],
        },
        FAST_MODEL,
        undefined,
        { thinkingConfig: { thinkingLevel: "low" } },
      );
      if (isVoice) {
        meta.title = out.title;
        text = (out.transcript ?? "").trim() || "(No clear speech in this voice note.)";
      } else {
        text = `**${out.title}**\n\n${out.notes ?? ""}`.trim();
      }
    }
    meta.readable = readable;

    const { data: ev, error } = await db()
      .from("events")
      .insert({ room_id: room, author: who, kind, text, meta })
      .select()
      .single();
    if (error) throw error;
    // A spoken "Huddle, research X" in a voice note starts work just like live speech does.
    if (kind === "voice" && readable) background(invokeFn("intake", { room, author: who, text, event_id: ev.id }));
    return json({ event: ev });
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
