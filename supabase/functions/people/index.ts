// POST { action, ... } -> private huddles by email.
//   request_code { email }                 email a 6-digit sign-in code (limited per email and per network)
//   verify_code { email, code }            -> { token }: a 30-day Huddle sign-in for that email
//   redeem_invite { invite }               the link in an invite email signs you in, no code needed
//   can_create                             may this caller start new huddles (ROOM_CREATORS on a personal server)
//   status { room }                        visibility, who you are here, a members-only file key; owners also get
//                                          the people list and pending requests. { exists: false } for no such room
//   prepare_private { room }               owner-to-be gets a short-lived "stay" pass to hand to people in the room
//   stay { stay }                          -> { token }: a guest pass for this room until the tab closes
//   make_private { room, emails, notify }  the caller becomes owner; only listed people (and guests) can get in
//   make_public { room }                   owner: anyone with the link can join again (the list is kept)
//   invite { room, emails }                owner: add people and email them a Join link
//   remove { room, email }                 owner: take someone off the list and turn off their AI links
//   leave { room }                         take yourself off the list
//   turn_off_ai { room, id }               owner: turn off one person's connected AI
//   ask { room, name }                     signed in but not on the list: ask the owner to let you in
//   request_status { room }                pending | admitted | declined
//   decide { room, id, admit }             owner: let someone in (adds them) or not
import { cors, db, json } from "../_shared/util.ts";
import { caller, fileKey, normEmail, signJwt, validEmail, verifyJwt } from "../_shared/auth.ts";
import { letter, mailConfigured, sendMail } from "../_shared/mail.ts";

const SITE = (Deno.env.get("PUBLIC_SITE_URL") ?? "").replace(/\/$/, "");
const OPERATOR_ROOM = Deno.env.get("OPERATOR_ROOM") ?? "huddle-operator";
const SESSION_DAYS = 30;
const CODE_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const SENDS_PER_HOUR = 5;

// deno-lint-ignore no-explicit-any
type Any = any;
const roomLink = (room: string) => `${SITE}/?room=${encodeURIComponent(room)}`;
async function sha256(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const sixDigits = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
const session = (email: string) => signJwt({ role: "authenticated", email }, SESSION_DAYS * 86_400);

// Per-network limit on code emails, kept in memory (the server runs these functions in one process).
// deno-lint-ignore no-explicit-any
const ipSends: Map<string, number[]> = ((globalThis as any).__huddleIpSends ??= new Map());
function ipAllowed(req: Request) {
  const ip = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "local";
  const now = Date.now();
  const recent = (ipSends.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= 20) return false;
  recent.push(now);
  ipSends.set(ip, recent);
  return true;
}

const emailsFrom = (list: unknown) =>
  [...new Set((Array.isArray(list) ? list : String(list ?? "").split(/[\s,;]+/)).map(normEmail).filter(Boolean))].slice(0, 50);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const { action } = body;
    const sb = db();
    const who = await caller(req);
    const me = who.email ? normEmail(who.email) : null;

    // ---------- signing in ----------
    if (action === "request_code") {
      const email = normEmail(body.email);
      if (!validEmail(email)) return json({ error: "That doesn't look like an email address." }, 400);
      if (!mailConfigured()) return json({ error: "Email sign-in isn't set up on this Huddle yet." }, 503);
      const { data: row } = await sb.from("email_codes").select("*").eq("email", email).maybeSingle();
      const now = Date.now();
      if (row && now - Date.parse(row.last_sent_at) < 30_000) return json({ error: "A code is on its way. Wait a moment before asking for another." }, 429);
      const fresh = !row || now - Date.parse(row.window_start) > 3_600_000;
      if (!fresh && row.sends >= SENDS_PER_HOUR) return json({ error: "Let's pause for a bit. Try again in an hour." }, 429);
      if (!ipAllowed(req)) return json({ error: "Let's pause for a bit. Try again later." }, 429);
      const code = sixDigits();
      const at = new Date(now).toISOString();
      const { error } = await sb.from("email_codes").upsert({
        email, code_hash: await sha256(`${email}:${code}`), expires_at: new Date(now + CODE_MINUTES * 60_000).toISOString(),
        attempts: 0, sends: fresh ? 1 : row.sends + 1, window_start: fresh ? at : row.window_start, last_sent_at: at,
      });
      if (error) throw error;
      const m = letter([`Your Huddle sign-in code is ${code}.`, `It works for ${CODE_MINUTES} minutes.`], undefined,
        "If you didn't ask for this, you can ignore this email.");
      await sendMail(email, `${code} is your Huddle code`, m.text, m.html);
      return json({ sent: true });
    }

    if (action === "verify_code") {
      const email = normEmail(body.email);
      const code = String(body.code ?? "").replace(/\D/g, "");
      const { data: row } = await sb.from("email_codes").select("*").eq("email", email).maybeSingle();
      if (!row || Date.parse(row.expires_at) < Date.now()) return json({ error: "That code has expired. Send a new one?", expired: true }, 400);
      if (row.attempts >= MAX_ATTEMPTS) return json({ error: "Too many tries. Send a new code.", expired: true }, 429);
      if (row.code_hash !== await sha256(`${email}:${code}`)) {
        await sb.from("email_codes").update({ attempts: row.attempts + 1 }).eq("email", email);
        return json({ error: "That code didn't work. Check it and try again." }, 400);
      }
      await sb.from("email_codes").delete().eq("email", email);
      await sb.from("room_people").update({ joined_at: new Date().toISOString() }).eq("email", email).is("joined_at", null);
      return json({ token: await session(email), email });
    }

    if (action === "redeem_invite") {
      const c = await verifyJwt(String(body.invite ?? ""));
      if (!c || c.purpose !== "invite" || typeof c.email !== "string" || typeof c.room !== "string") {
        return json({ error: "This invite link has expired. Sign in with your email instead." }, 400);
      }
      const { data: p } = await sb.from("room_people").select("email").eq("room_id", c.room).eq("email", c.email).maybeSingle();
      if (!p) return json({ error: "This invite is no longer active. Ask the owner to invite you again." }, 403);
      await sb.from("room_people").update({ joined_at: new Date().toISOString() }).eq("room_id", c.room).eq("email", c.email).is("joined_at", null);
      return json({ token: await session(c.email), email: c.email, room: c.room });
    }

    if (action === "stay") {
      const c = await verifyJwt(String(body.stay ?? ""));
      if (!c || c.purpose !== "stay" || typeof c.room !== "string") return json({ error: "too late to stay" }, 400);
      // Keep the caller's email sign-in in the same pass, so a person on the list stays themselves.
      return json({ token: await signJwt({ role: "authenticated", guest_room: c.room, ...(me ? { email: me } : {}) }, 12 * 3600) });
    }

    // Who may start huddles: anyone, unless this server lists its creators (ROOM_CREATORS).
    const { data: creators } = await sb.from("room_creators").select("email");
    const locked = !!creators?.length;
    const canCreate = !locked || (!!me && creators!.some((c: Any) => c.email === me));
    if (action === "can_create") return json({ locked, can_create: canCreate, signed_in: !!me, email: me, email_ready: mailConfigured() });

    // ---------- everything below is about one room ----------
    const roomId = String(body.room ?? "");
    if (!/^[\w-]{1,64}$/.test(roomId)) return json({ error: "room required" }, 400);
    const { data: room } = await sb.from("rooms").select("id, name, visibility, owner_id, repo").eq("id", roomId).maybeSingle();
    if (!room) {
      return action === "status"
        ? json({ exists: false, can_create: canCreate, signed_in: !!me, email_ready: mailConfigured() })
        : json({ error: "This huddle doesn't exist." }, 404);
    }
    const { data: people } = await sb.from("room_people").select("email, role, name, added_at, joined_at").eq("room_id", roomId).order("added_at");
    const owner = (people ?? []).find((p: Any) => p.role === "owner")?.email ?? null;
    const mine = me ? (people ?? []).find((p: Any) => p.email === me) : null;
    const isOwner = !!me && owner === me;
    const priv = room.visibility === "private";
    const roomName = room.name || `Room ${roomId}`;
    const canSee = !priv || !!mine || who.guestRoom === roomId || who.service ||
      (who.uid != null && Number(room.owner_id) === who.uid);
    const ownerOnly = () => (isOwner || who.service ? null : json({ error: "Only the owner of this huddle can do that." }, 403));

    async function addPeople(emails: string[], by: string, notify: boolean) {
      const fresh = emails.filter((e) => validEmail(e) && !(people ?? []).some((p: Any) => p.email === e));
      if (fresh.length) {
        const { error } = await sb.from("room_people").insert(fresh.map((email) => ({ room_id: roomId, email, role: "member", added_by: by })));
        if (error) throw error;
      }
      let sent = 0;
      if (notify && mailConfigured()) {
        for (const email of fresh) {
          const invite = await signJwt({ role: "anon", purpose: "invite", email, room: roomId }, 14 * 86_400);
          const m = letter([`${by} invited you to “${roomName}” on Huddle.`, "It's a private huddle: only invited people can get in."],
            { label: "Join", url: `${roomLink(roomId)}#invite=${invite}` }, "This link is just for you. Don't forward it.");
          try { await sendMail(email, `${by} invited you to “${roomName}”`, m.text, m.html); sent++; } catch (e) { console.warn("invite mail", e); }
        }
      }
      return { added: fresh, sent, skipped: emails.filter((e) => !validEmail(e)) };
    }

    if (action === "status") {
      if (!canSee) return json({ visibility: room.visibility, me: me ? { email: me, member: false } : null, can_see: false, email_ready: mailConfigured() });
      const out: Any = {
        visibility: room.visibility, can_see: true, is_owner: isOwner, has_owner: !!owner, signed_in: !!me,
        me: me ? { email: me, member: !!mine, role: mine?.role ?? null } : null,
        guest: who.guestRoom === roomId, file_key: priv ? await fileKey(roomId) : null, email_ready: mailConfigured(),
      };
      if (isOwner) {
        const { data: links } = await sb.from("mcp_links").select("id, label, created_by_email, created_at, last_used_at")
          .eq("room_id", roomId).is("revoked_at", null);
        out.people = (people ?? []).map((p: Any) => ({ ...p, ais: (links ?? []).filter((l: Any) => l.created_by_email === p.email) }));
        const { data: reqs } = await sb.from("join_requests").select("id, email, name, created_at").eq("room_id", roomId).eq("status", "pending").order("id");
        out.requests = reqs ?? [];
      }
      return json(out);
    }

    if (action === "prepare_private" || action === "make_private") {
      if (roomId === OPERATOR_ROOM || room.repo?.self) return json({ error: "The Operator room can't be made private." }, 400);
      if (!me) return json({ error: "Sign in with your email first.", need_signin: true }, 401);
      if (owner && !isOwner) return json({ error: "Only the owner of this huddle can do that." }, 403);
      if (room.owner_id != null && Number(room.owner_id) !== who.uid) return json({ error: "This huddle's privacy is managed on GitHub by its owner." }, 403);
      if (!canSee) return json({ error: "This huddle is private." }, 403);
      if (action === "prepare_private") return json({ stay: await signJwt({ role: "anon", purpose: "stay", room: roomId }, 120) });
      if (!owner) {
        const { error } = await sb.from("room_people").upsert({ room_id: roomId, email: me, role: "owner", added_by: me, joined_at: new Date().toISOString() });
        if (error) throw error;
      }
      const r = await addPeople(emailsFrom(body.emails).filter((e) => e !== me), me, !!body.notify);
      const { error } = await sb.from("rooms").update({ visibility: "private" }).eq("id", roomId);
      if (error) throw error;
      return json({ visibility: "private", ...r });
    }

    if (action === "make_public") {
      const no = ownerOnly(); if (no) return no;
      const { error } = await sb.from("rooms").update({ visibility: "public" }).eq("id", roomId);
      if (error) throw error;
      return json({ visibility: "public" });
    }

    if (action === "invite") {
      const no = ownerOnly(); if (no) return no;
      return json(await addPeople(emailsFrom(body.emails).filter((e) => e !== me), me ?? "The owner", true));
    }

    if (action === "remove" || action === "leave") {
      const email = action === "leave" ? me : normEmail(body.email);
      if (!email) return json({ error: "Sign in with your email first.", need_signin: true }, 401);
      if (action === "remove") { const no = ownerOnly(); if (no) return no; }
      if (email === owner) return json({ error: "The owner can't be removed. Make the huddle public or delete it instead." }, 400);
      await sb.from("room_people").delete().eq("room_id", roomId).eq("email", email);
      await sb.from("mcp_links").update({ revoked_at: new Date().toISOString() }).eq("room_id", roomId).eq("created_by_email", email).is("revoked_at", null);
      // Re-saving the room makes the server re-check everyone connected and disconnect whoever lost access.
      if (priv) await sb.from("rooms").update({ visibility: "private" }).eq("id", roomId);
      return json({ removed: email });
    }

    if (action === "turn_off_ai") {
      const no = ownerOnly(); if (no) return no;
      const { error } = await sb.from("mcp_links").update({ revoked_at: new Date().toISOString() }).eq("room_id", roomId).eq("id", Number(body.id));
      if (error) throw error;
      return json({ turned_off: Number(body.id) });
    }

    if (action === "ask") {
      if (!me) return json({ error: "Sign in with your email first.", need_signin: true }, 401);
      if (mine) return json({ status: "admitted" });
      const name = String(body.name ?? "").trim().slice(0, 60) || null;
      const { data: existing } = await sb.from("join_requests").select("id").eq("room_id", roomId).eq("email", me).eq("status", "pending").maybeSingle();
      if (!existing) {
        const { error } = await sb.from("join_requests").insert({ room_id: roomId, email: me, name });
        if (error) throw error;
        if (owner && mailConfigured()) {
          const m = letter([`${name ? `${name} (${me})` : me} wants to join “${roomName}”.`], { label: "Open the huddle", url: roomLink(roomId) },
            "Let them in or say no from the People panel in the huddle.");
          sendMail(owner, `${name ?? me} wants to join “${roomName}”`, m.text, m.html).catch((e) => console.warn("ask mail", e));
        }
      }
      return json({ status: "pending" });
    }

    if (action === "request_status") {
      if (!me) return json({ status: "none" });
      if (mine) return json({ status: "admitted" });
      const { data: r } = await sb.from("join_requests").select("status").eq("room_id", roomId).eq("email", me).order("id", { ascending: false }).limit(1).maybeSingle();
      return json({ status: r?.status ?? "none" });
    }

    if (action === "decide") {
      const no = ownerOnly(); if (no) return no;
      const { data: r } = await sb.from("join_requests").select("*").eq("id", Number(body.id)).eq("room_id", roomId).eq("status", "pending").maybeSingle();
      if (!r) return json({ error: "That request was already handled." }, 404);
      await sb.from("join_requests").update({ status: body.admit ? "admitted" : "declined", decided_at: new Date().toISOString() }).eq("id", r.id);
      if (body.admit) {
        await addPeople([r.email], me ?? "The owner", false);
        // They proved their email to ask, so they count as signed in.
        await sb.from("room_people").update({ name: r.name, joined_at: new Date().toISOString() }).eq("room_id", roomId).eq("email", r.email);
        if (mailConfigured()) {
          const m = letter([`You're in. ${me ?? "The owner"} let you into “${roomName}”.`], { label: "Open the huddle", url: roomLink(roomId) });
          sendMail(r.email, `You're in “${roomName}”`, m.text, m.html).catch((e) => console.warn("admit mail", e));
        }
      }
      return json({ decided: body.admit ? "admitted" : "declined" });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
