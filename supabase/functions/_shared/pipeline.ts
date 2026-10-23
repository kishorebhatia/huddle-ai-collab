// Shared helpers for autonomous pipelines.
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

// Builds are viewed in the room. They're published to a public host (the publish question, then "host") only
// where public hosting is set up: Daytona or Vercel, or PUBLISH_BUILDS=1 for the share page on this site.
export const publishesBuilds = () =>
  (Deno.env.get("PUBLISH_BUILDS") ?? (Deno.env.get("HOST_MODE") || Deno.env.get("DAYTONA_API_KEY") ? "1" : "0")) === "1";
export const buildStages = () => publishesBuilds() ? ["prototype", "review", "host"] : ["prototype", "review"];

// Every pipeline starts with a plan; the plan rewrites the stages that follow (see orchestrate).
export const STAGE_SETS: Record<string, string[]> = {
  research: ["plan", "research", "review"],
  get build() { return ["plan", "research", "review", ...buildStages()]; },
  get prototype() { return ["plan", ...buildStages()]; },
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
  return ["plan", ...research, ...(plan.deliverable === "app" ? buildStages() : [])];
}

export type Room = {
  id: string; mode: "suggest" | "auto" | "full"; paused: boolean; max_jobs_per_hour: number;
  work_by?: "auto" | "huddle" | "members_first" | "members_only"; handoff_minutes?: number;
};

export async function getRoom(sb: SupabaseClient, roomId: string): Promise<Room> {
  const { data } = await sb.from("rooms").select("*").eq("id", roomId).maybeSingle();
  if (data) return data as Room;
  const { data: created } = await sb.from("rooms").upsert({ id: roomId }).select().single();
  return (created ?? { id: roomId, mode: "auto", paused: false, max_jobs_per_hour: 20, work_by: "auto" }) as Room;
}

// Stages a member's own AI can take (MCP claim_task / submit_work). Plan, publish, PR and ship stay
// with Huddle: they're cheap, or need Huddle's sandboxes and tokens.
export const MEMBER_STAGES = ["research", "prototype", "review"];

// In auto mode, a member's AI counts as around if its link was used in the room this recently.
const ACTIVE_MS = 60 * 60_000;

/** Should this stage wait for a member's AI instead of running on Huddle's models? */
export async function forMembers(sb: SupabaseClient, room: Room, stage: string, pipeline?: { meta?: any }) {
  // The operator room changes Huddle itself; members' AIs contribute there with propose_change.
  if (room.id === OPERATOR_ROOM || !MEMBER_STAGES.includes(stage)) return false;
  // A build that runs with the room's keys stays with Huddle: code from someone's AI would run in a
  // sandbox holding those keys and could send them anywhere.
  if (stage === "prototype" && (pipeline?.meta?.plan?.required_inputs ?? []).length) return false;
  const by = room.work_by ?? "auto";
  if (by === "members_first" || by === "members_only") return true;
  if (by !== "auto") return false;
  // auto: only when someone's AI has been active here lately, so rooms without one never wait.
  const { count } = await sb.from("mcp_links").select("id", { count: "exact", head: true })
    .eq("room_id", room.id).is("revoked_at", null).gte("last_used_at", new Date(Date.now() - ACTIVE_MS).toISOString());
  return (count ?? 0) > 0;
}

/** Minutes an open task waits for members' AIs before Huddle takes it; 0 = never (members_only). */
export function handoffMinutes(room: Room) {
  return room.work_by === "members_only" ? 0 : Math.max(1, room.handoff_minutes ?? 10);
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
