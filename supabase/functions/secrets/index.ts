// POST { room, action, ... } -> keys a build needs. Write-only: nothing here ever returns a value.
//   status { names }              which names this room has, and which the caller saved to their account
//   set { name, value, save? }    store for this room; save: also to the signed-in caller's account
//   use_saved { name }            copy the caller's saved key into this room
import { cors, db, json } from "../_shared/util.ts";
import { caller, decryptSecret } from "../_shared/auth.ts";
import { SECRET_NAME, secretNames, serverKeysMissing, setRoomSecret, setServerSecret, setUserSecret } from "../_shared/vault.ts";

const ADMINS = (Deno.env.get("ADMIN_LOGINS") ?? "kishorebhatia").toLowerCase().split(",").map((x) => x.trim());

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { room, action, name, value, save, names } = await req.json().catch(() => ({}));
    if (!room || !action) return json({ error: "room and action required" }, 400);
    const who = await caller(req);
    const sb = db();

    if (action === "status") {
      const list = (Array.isArray(names) ? names : []).filter((n: string) => SECRET_NAME.test(n)).slice(0, 10);
      const { have, missing } = await secretNames(sb, room, list);
      const { data: saved } = who.uid && list.length
        ? await sb.from("user_secrets").select("name").eq("user_id", who.uid).in("name", list) : { data: [] };
      return json({ have, missing, saved: (saved ?? []).map((s: { name: string }) => s.name), signed_in: !!who.uid });
    }

    if (action === "status_server") {
      const list = (Array.isArray(names) ? names : []).filter((n: string) => SECRET_NAME.test(n)).slice(0, 10);
      const missing = await serverKeysMissing(sb, list);
      return json({ have: list.filter((n: string) => !missing.includes(n)), missing, admin: !!who.login && ADMINS.includes(who.login.toLowerCase()) });
    }

    if (!SECRET_NAME.test(String(name ?? ""))) return json({ error: "Key names look like ELEVENLABS_API_KEY" }, 400);

    if (action === "set_server") {
      // Server keys change what production runs on: admins only.
      if (!who.uid || !who.login || !ADMINS.includes(who.login.toLowerCase())) return json({ error: "Only a Huddle admin can add server keys" }, 403);
      const v = String(value ?? "").trim();
      if (v.length < 8 || v.length > 4096 || /\s/.test(v)) return json({ error: "That doesn't look like a key" }, 400);
      await setServerSecret(sb, name, v, who.uid);
      return json({ ok: true });
    }

    if (action === "set") {
      const v = String(value ?? "").trim();
      if (v.length < 8 || v.length > 4096 || /\s/.test(v)) return json({ error: "That doesn't look like a key" }, 400);
      await setRoomSecret(sb, room, name, v, who.uid);
      if (save && who.uid) await setUserSecret(sb, who.uid, name, v);
      return json({ ok: true, saved_to_account: !!(save && who.uid) });
    }

    if (action === "use_saved") {
      if (!who.uid) return json({ error: "Sign in to use a saved key", need_signin: true }, 401);
      const { data } = await sb.from("user_secrets").select("value_enc").eq("user_id", who.uid).eq("name", name).maybeSingle();
      if (!data) return json({ error: `You haven't saved ${name}` }, 404);
      await setRoomSecret(sb, room, name, await decryptSecret(data.value_enc), who.uid);
      return json({ ok: true });
    }
    return json({ error: `unknown action ${action}` }, 400);
  } catch (e) {
    console.error("secrets", (e as Error)?.name); // never log the request or the error text: either could hold a key
    return json({ error: "Couldn't store that key" }, 500);
  }
});
