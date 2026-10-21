// POST { room, confirm } -> deletes the huddle: its notes, board, work, AI links and uploaded files.
// `confirm` must repeat the room id, so a stray call can't delete anything.
// Who may delete: the owner of an owned room (private rooms always have one: by email or GitHub). A room nobody owns can be
// deleted by anyone who has its link, the same people who can rename it. The operator room never.
// A GitHub repository the room published to is left alone; the response says where it is.
import { cors, db, json } from "../_shared/util.ts";
import { caller } from "../_shared/auth.ts";

const OPERATOR_ROOM = Deno.env.get("OPERATOR_ROOM") ?? "huddle-operator";
// Set by aws/docker-compose.yml: self-hosted uploads are plain files on disk. Unset on Supabase.
const STORAGE_DIR = Deno.env.get("STORAGE_DIR");

/** Remove every upload under board/<room>/. Self-hosted: files on local disk. Supabase: the storage API. */
async function removeUploads(sb: ReturnType<typeof db>, room: string) {
  if (STORAGE_DIR) {
    await Deno.remove(`${STORAGE_DIR}/board/${room}`, { recursive: true }).catch((e) => {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    });
    return;
  }
  // Supabase lists one folder level at a time; uploads sit at board/<room>/<folder>/<file>.
  const bucket = sb.storage.from("board");
  const { data: folders } = await bucket.list(room, { limit: 1000 });
  for (const f of folders ?? []) {
    const dir = `${room}/${f.name}`;
    const { data: files } = await bucket.list(dir, { limit: 1000 });
    const paths = (files ?? []).map((x) => `${dir}/${x.name}`);
    if (!files?.length) paths.push(dir); // a file directly under the room folder
    if (paths.length) await bucket.remove(paths);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { room, confirm } = await req.json().catch(() => ({}));
    if (typeof room !== "string" || !/^[\w-]{1,64}$/.test(room)) return json({ error: "room required" }, 400);
    if (confirm !== room) return json({ error: "confirm must repeat the room id" }, 400);
    if (room === OPERATOR_ROOM) return json({ error: "The operator room can't be deleted." }, 403);

    const sb = db();
    const { data: r, error } = await sb.from("rooms").select("id, owner_id, repo").eq("id", room).maybeSingle();
    if (error) throw error;
    if (!r) return json({ deleted: false });
    if (r.repo?.self) return json({ error: "The operator room can't be deleted." }, 403);

    const who = await caller(req);
    const { data: emailOwner } = await sb.from("room_people").select("email").eq("room_id", room).eq("role", "owner").maybeSingle();
    const ownerMismatch = emailOwner
      ? who.email?.toLowerCase() !== emailOwner.email
      : r.owner_id != null && Number(r.owner_id) !== who.uid;
    if (!who.service && ownerMismatch) {
      return json({ error: "Only the person who owns this huddle can delete it." }, 403);
    }

    await removeUploads(sb, room);
    const { error: delError } = await sb.rpc("delete_room", { r: room });
    if (delError) throw delError;
    return json({ deleted: true, repo_kept: r.repo?.html_url ?? null });
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
