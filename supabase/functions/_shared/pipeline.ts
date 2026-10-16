// Shared helpers for autonomous pipelines.
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

// Every pipeline starts with a plan; the plan rewrites the stages that follow (see orchestrate).
export const STAGE_SETS: Record<string, string[]> = {
  research: ["plan", "research", "review"],
  build: ["plan", "research", "review", "prototype", "review", "host"],
  prototype: ["plan", "prototype", "review", "host"],
  // The operator room: change Huddle's own prompts, review the change, open a pull request.
  // Operator room: triage first (a change to Huddle, or not?), then change any file, review, PR, ship.
  improve: ["triage", "change", "review", "pr", "ship"],
  // A change an outside agent wrote itself (MCP propose_change): verify, review, PR, ship.
  submitted: ["change", "review", "pr", "ship"],
};
export const OPERATOR_ROOM = Deno.env.get("OPERATOR_ROOM") ?? "huddle-operator";

/** The stages a plan calls for. */
export function stagesFor(plan: { deliverable?: string; needs_research?: boolean }): string[] {
  const research = plan.deliverable !== "app" || plan.needs_research ? ["research", "review"] : [];
  return ["plan", ...research, ...(plan.deliverable === "app" ? ["prototype", "review", "host"] : [])];
}

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
  opts: { room: string; title: string; goal: string; kind: string; created_by?: string; origin_event_id?: number; meta?: Record<string, unknown> },
) {
  const room = await getRoom(sb, opts.room);
  // Don't start the same work twice: the brief update and a request often name the same next step.
  const words = (t: string) => new Set(t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2));
  const mine = words(opts.title);
  const { data: active } = await sb.from("pipelines").select("id, title, status")
    .eq("room_id", opts.room).in("status", ["proposed", "running", "waiting"])
    .gte("created_at", new Date(Date.now() - 30 * 60_000).toISOString());
  const twin = (active ?? []).find((p: { title: string }) => {
    const theirs = words(p.title);
    const shared = [...mine].filter((w) => theirs.has(w)).length;
    return shared / Math.max(1, Math.min(mine.size, theirs.size)) >= 0.8;
  });
  if (twin) return twin;
  // In the operator room every request is a change to Huddle itself.
  if (opts.room === OPERATOR_ROOM && opts.kind !== "submitted") opts = { ...opts, kind: "improve" };
  const stages = STAGE_SETS[opts.kind] ?? STAGE_SETS.research;
  const status = room.mode === "suggest" || room.paused ? "proposed" : "running";
  const { data: p, error } = await sb.from("pipelines").insert({
    room_id: opts.room, title: opts.title.slice(0, 120), goal: opts.goal, stages, status,
    created_by: opts.created_by ?? "huddle", origin_event_id: opts.origin_event_id ?? null, meta: opts.meta ?? {},
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
