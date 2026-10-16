// POST { room, author, audio: base64 WAV (16 kHz mono) } -> inserts a 'speech' event
import { background, cors, db, gemini, geminiJson, json } from "../_shared/util.ts";
import { invokeFn } from "../_shared/pipeline.ts";

const words = (s: string) =>
  new Set(s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").split(/\s+/).filter(Boolean));

function similar(a: string, b: string) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / Math.min(A.size, B.size);
}

/** RMS loudness of a 16-bit PCM WAV (base64). Quiet clips make Gemini invent words. */
function wavRms(b64: string): number {
  const bin = atob(b64);
  const n = Math.floor((bin.length - 44) / 2);
  if (n <= 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const o = 44 + i * 2;
    let s = bin.charCodeAt(o) | (bin.charCodeAt(o + 1) << 8);
    if (s & 0x8000) s -= 0x10000;
    sum += (s / 32768) ** 2;
  }
  return Math.sqrt(sum / n);
}

// Dedicated speech model: ~1 s per utterance, returns nothing for noise. Fallback: Flash-Lite with JSON.
const TRANSCRIBE_MODEL = Deno.env.get("TRANSCRIBE_MODEL") ?? "gemini-3.5-transcribe";
const FALLBACK_MODEL = Deno.env.get("TRANSCRIBE_FALLBACK_MODEL") ?? "gemini-3.5-flash-lite";

type Transcript = { has_speech: boolean; text: string; language?: string };

async function transcribe(audio: string): Promise<Transcript> {
  try {
    const { raw } = await gemini(
      { contents: [{ role: "user", parts: [{ inline_data: { mime_type: "audio/wav", data: audio } }]}] },
      TRANSCRIBE_MODEL,
    );
    const parts = raw?.candidates?.[0]?.content?.parts ?? [];
    const text = parts.map((p: any) => p.audioTranscription?.text ?? p.text ?? "").join(" ").trim();
    return { has_speech: text.length > 0, text };
  } catch (e) {
    console.warn(`transcribe model failed, falling back: ${e}`);
  }
  return await geminiJson<Transcript>(
    [
      { inline_data: { mime_type: "audio/wav", data: audio } },
      {
        text:
          "Transcribe the speech in this audio clip verbatim, in the language spoken. " +
          "Clean up only obvious stutters. Set has_speech to false and text to an empty string " +
          "if there is no clearly intelligible speech (silence, noise, background chatter). " +
          "Never guess words.",
      },
    ],
    {
      type: "OBJECT",
      properties: { has_speech: { type: "BOOLEAN" }, text: { type: "STRING" }, language: { type: "STRING" } },
      required: ["has_speech", "text"],
    },
    FALLBACK_MODEL,
  );
}

// Names speech models routinely mishear. Add your own: "heard" -> "meant".
const VOCAB: [RegExp, string][] = [
  [/\bsuper ?base\b/gi, "Supabase"],
  [/\bgemini\b/gi, "Gemini"],
  [/\bhuddle\b/gi, "Huddle"],
];
const fixVocab = (s: string) => VOCAB.reduce((t, [re, to]) => t.replace(re, to), s);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    // `text` instead of `audio`: the browser already transcribed it (its own speech recognition).
    const { room, author, audio, text: said } = await req.json().catch(() => ({}));
    if (!room || !(audio || said)) return json({ error: "room and audio (or text) required" }, 400);
    if (!said && wavRms(audio) < 0.003) return json({ skipped: "silence" });

    const out = said ? { has_speech: true, text: String(said).slice(0, 4000) } : await transcribe(audio);
    const text = fixVocab(out.text ?? "").trim();
    if (!out.has_speech || text.length < 2) return json({ skipped: "no speech" });

    // Three laptops in one room hear the same voice: drop near-duplicates from other mics.
    const sb = db();
    const since = new Date(Date.now() - 25_000).toISOString();
    const { data: recent } = await sb
      .from("events")
      .select("id, author, text")
      .eq("room_id", room)
      .eq("kind", "speech")
      .gte("created_at", since)
      .neq("author", author ?? "");
    const dup = (recent ?? []).find((e) => similar(e.text ?? "", text) > 0.7);
    if (dup) return json({ skipped: "duplicate", of: dup.id });

    const { data, error } = await sb
      .from("events")
      .insert({ room_id: room, author: author ?? "someone", kind: "speech", text, meta: { language: out.language } })
      .select()
      .single();
    if (error) throw error;
    // Spoken requests ("Huddle, research X") start a pipeline right away, after we've replied.
    background(invokeFn("intake", { room, author, text, event_id: data.id }));
    return json({ event: data });
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
