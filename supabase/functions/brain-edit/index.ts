// POST { room, action: 'lock' | 'unlock', text, by? } -> the team locks a decision so brief updates keep it word for word.
import { cors, db, json } from "../_shared/util.ts";

type Locked = { text: string; by?: string; refs?: number[] };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { room, action, text, by, refs } = await req.json().catch(() => ({}));
    const t = String(text ?? "").trim().slice(0, 500);
    if (!room || !t || !["lock", "unlock"].includes(action)) return json({ error: "room, text and action (lock | unlock) required" }, 400);
    const sb = db();
    const { data: brain } = await sb.from("brain").select("room_id, locked").eq("room_id", room).maybeSingle();
    if (!brain) return json({ error: "this room has no brief yet" }, 404);
    let locked: Locked[] = Array.isArray(brain.locked) ? brain.locked : [];
    locked = locked.filter((l) => l.text !== t);
    if (action === "lock") locked.push({ text: t, by: by ?? undefined, refs: Array.isArray(refs) ? refs.slice(0, 8) : [] });
    const { data, error } = await sb.from("brain").update({ locked }).eq("room_id", room).select("locked").single();
    if (error) throw error;
    return json({ locked: data.locked });
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
