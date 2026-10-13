// POST { room, author, minutes? = 2 } -> erases what this person said (live speech and voice notes)
// in the last few minutes. Rows stay so every open browser updates live, but their content is wiped.
import { cors, db, json } from "../_shared/util.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { room, author, minutes } = await req.json().catch(() => ({}));
    if (!room || !author) return json({ error: "room and author required" }, 400);
    const mins = Math.min(Math.max(Number(minutes) || 2, 1), 10);
    const since = new Date(Date.now() - mins * 60_000).toISOString();
    const { data, error } = await db()
      .from("events")
      .update({ forgotten: true, text: null, image_url: null, meta: { forgotten_at: new Date().toISOString() } })
      .eq("room_id", room)
      .eq("author", author)
      .in("kind", ["speech", "voice"])
      .eq("forgotten", false)
      .gte("created_at", since)
      .select("id");
    if (error) throw error;
    return json({ forgotten: (data ?? []).map((e) => e.id) });
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
