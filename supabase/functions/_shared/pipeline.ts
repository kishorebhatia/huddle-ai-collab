// Shared helpers for autonomous pipelines.
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export const STAGE_SETS: Record<string, string[]> = {
  research: ["research", "review"],
  build: ["research", "review", "prototype", "review", "host"],
  prototype: ["prototype", "review", "host"],
};

export type Room = { id: string; mode: "suggest" | "auto" | "full"; paused: boolean; max_jobs_per_hour: number };

export async function getRoom(sb: SupabaseClient, roomId: string): Promise<Room> {
  const { data } = await sb.from("rooms").select("*").eq("id", roomId).maybeSingle();
  if (data) return data as Room;
  const { data: created } = await sb.from("rooms").upsert({ id: roomId }).select().single();
  return (created ?? { id: roomId, mode: "auto", paused: false, max_jobs_per_hour: 20 }) as Room;
}

/** Call another Edge Function in this project (fire-and-wait for the quick ack). */
export async function invokeFn(name: string, body: unknown) {
  const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/${name}`;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}`, apikey: key },
      body: JSON.stringify(body),
    });
    return await r.json().catch(() => ({}));
  } catch (e) {
    console.error(`invoke ${name} failed`, e);
    return { error: String(e) };
  }
}

export async function postEvent(sb: SupabaseClient, room: string, text: string, meta: Record<string, unknown> = {}) {
  await sb.from("events").insert({ room_id: room, author: "huddle", kind: "system", text, meta });
}

/** Create a pipeline for a next step and (unless the room is in Suggest mode) start it. */
export async function createPipeline(
  sb: SupabaseClient,
  opts: { room: string; title: string; goal: string; kind: string; created_by?: string; origin_event_id?: number },
) {
  const room = await getRoom(sb, opts.room);
  const stages = STAGE_SETS[opts.kind] ?? STAGE_SETS.research;
  const status = room.mode === "suggest" || room.paused ? "proposed" : "running";
  const { data: p, error } = await sb.from("pipelines").insert({
    room_id: opts.room, title: opts.title.slice(0, 120), goal: opts.goal, stages, status,
    created_by: opts.created_by ?? "huddle", origin_event_id: opts.origin_event_id ?? null,
  }).select().single();
  if (error) throw error;
  await postEvent(
    sb, opts.room,
    status === "running"
      ? `Started: ${p.title} (${stages.join(" → ")})`
      : `Proposed: ${p.title} (${stages.join(" → ")}). Start it from Agent work.`,
    { pipeline_id: p.id },
  );
  if (status === "running") await invokeFn("orchestrate", { pipeline_id: p.id });
  return p;
}
