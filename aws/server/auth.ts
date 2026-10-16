// Sign in with GitHub (OAuth App). Scopes grow only when needed:
//   default → public_repo user:email   (create public repos for your rooms, know your email)
//   ?scope=private → repo user:email   (also private repos, asked when someone turns a room private)
// The callback stores the encrypted GitHub token and sends the browser back with a Huddle JWT in the URL fragment.
import type postgres from "npm:postgres@3.4.5";
import { encryptSecret, signJwt, verifyJwt } from "../../supabase/functions/_shared/auth.ts";

const CLIENT_ID = Deno.env.get("GITHUB_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("GITHUB_CLIENT_SECRET") ?? "";
const SITE = (Deno.env.get("PUBLIC_SITE_URL") ?? "").replace(/\/$/, "");

const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to, "cache-control": "no-store" } });
// Only send people back to pages on this site.
const safeReturn = (r: string | null) => (r && r.startsWith("/") && !r.startsWith("//") ? r : "/");

export async function handleAuth(req: Request, url: URL, sql: ReturnType<typeof postgres>): Promise<Response | null> {
  if (url.pathname === "/auth/github/login") {
    if (!CLIENT_ID) return new Response("GitHub sign-in is not configured", { status: 503 });
    const scope = url.searchParams.get("scope") === "private" ? "repo user:email" : "public_repo user:email";
    const state = await signJwt({ role: "oauth_state", ret: safeReturn(url.searchParams.get("return")), nonce: crypto.randomUUID() }, 600);
    const q = new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: `${SITE}/auth/github/callback`, scope, state, allow_signup: "true" });
    return redirect(`https://github.com/login/oauth/authorize?${q}`);
  }

  if (url.pathname === "/auth/github/callback") {
    const state = await verifyJwt(url.searchParams.get("state") ?? "");
    const code = url.searchParams.get("code");
    if (!state || state.role !== "oauth_state" || !code) return new Response("Sign-in expired. Go back and try again.", { status: 400 });
    const ret = String(state.ret ?? "/");
    const tok = await (await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code, redirect_uri: `${SITE}/auth/github/callback` }),
    })).json();
    if (!tok.access_token) return new Response(`GitHub sign-in failed: ${tok.error_description ?? tok.error ?? "no token"}`, { status: 400 });
    const gh = { authorization: `Bearer ${tok.access_token}`, accept: "application/vnd.github+json", "user-agent": "huddle" };
    const u = await (await fetch("https://api.github.com/user", { headers: gh })).json();
    const emails = await (await fetch("https://api.github.com/user/emails", { headers: gh })).json().catch(() => []);
    const email = (Array.isArray(emails) ? emails : []).find((e: { primary: boolean; verified: boolean }) => e.primary && e.verified)?.email ?? u.email ?? null;
    const [row] = await sql`
      insert into public.users (github_id, login, name, avatar_url, email, token_enc, scopes)
      values (${u.id}, ${u.login}, ${u.name ?? null}, ${u.avatar_url ?? null}, ${email}, ${await encryptSecret(tok.access_token)}, ${tok.scope ?? ""})
      on conflict (github_id) do update set login = excluded.login, name = excluded.name, avatar_url = excluded.avatar_url,
        email = excluded.email, token_enc = excluded.token_enc, scopes = excluded.scopes, updated_at = now()
      returning id, login, name, avatar_url, scopes`;
    // The admin owns the operator room (Huddle improving Huddle); it is private to them and their invitees.
    const admins = (Deno.env.get("ADMIN_LOGINS") ?? "kishorebhatia").toLowerCase().split(",").map((x) => x.trim());
    if (admins.includes(String(row.login).toLowerCase())) {
      const op = Deno.env.get("OPERATOR_ROOM") ?? "huddle-operator";
      await sql`insert into public.rooms (id, name, owner_id, visibility) values (${op}, 'Huddle operator', ${row.id}, 'private')
        on conflict (id) do update set owner_id = coalesce(public.rooms.owner_id, excluded.owner_id), visibility = 'private'`;
      await sql`insert into public.room_members (room_id, user_id, login, role) values (${op}, ${row.id}, ${row.login}, 'owner')
        on conflict (room_id, login) do update set user_id = excluded.user_id`;
    }
    // Invitations made by GitHub login become real memberships now that we know who this is.
    await sql`update public.room_members set user_id = ${row.id} where lower(login) = lower(${row.login}) and user_id is null`;
    const jwt = await signJwt({ role: "authenticated", sub: String(row.id), login: row.login });
    const profile = { id: row.id, login: row.login, name: row.name, avatar_url: row.avatar_url, private_ok: String(row.scopes).split(",").includes("repo") };
    const frag = new URLSearchParams({ huddle_token: jwt, huddle_user: JSON.stringify(profile) });
    return redirect(`${SITE}${ret}#${frag}`);
  }
  return null;
}
