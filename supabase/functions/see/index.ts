// POST { room, author, image_url, caption? } -> Gemini reads the sketch/photo/screenshot, inserts an 'image' event
import { cors, db, FAST_MODEL, geminiJson, json, toBase64 } from "../_shared/util.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { room, author, image_url, caption } = await req.json();
    if (!room || !image_url) return json({ error: "room and image_url required" }, 400);

    const img = await fetch(image_url);
    if (!img.ok) throw new Error(`could not fetch image: ${img.status}`);
    const mime = img.headers.get("content-type")?.split(";")[0] ?? "image/png";
    const data = toBase64(await img.arrayBuffer());

    const out = await geminiJson<{ title: string; notes: string }>(
      [
        { inline_data: { mime_type: mime, data } },
        {
          text:
            "A teammate shared this image in a live team brainstorm. It may be a whiteboard photo, a " +
            "hand sketch, a UI mockup or a screenshot. Extract everything useful as concise markdown " +
            "notes: all written text copied exactly as written (do not correct names or version numbers), " +
            "the structure of any diagram (boxes, arrows, what connects to what), and the ideas or " +
            "decisions it implies. Plain markdown only, no LaTeX. Give it a short title." +
            (caption ? `\nTheir caption: ${caption}` : ""),
        },
      ],
      {
        type: "OBJECT",
        properties: { title: { type: "STRING" }, notes: { type: "STRING" } },
        required: ["title", "notes"],
      },
      FAST_MODEL,
      undefined,
      { thinkingConfig: { thinkingLevel: "low" } },
    );

    const { data: ev, error } = await db()
      .from("events")
      .insert({
        room_id: room,
        author: author ?? "someone",
        kind: "image",
        text: `**${out.title}**\n\n${out.notes}`,
        image_url,
        meta: caption ? { caption } : {},
      })
      .select()
      .single();
    if (error) throw error;
    return json({ event: ev });
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
