// Sign-in tokens and secret storage for GitHub-backed rooms.
// Huddle signs its own JWTs with the same secret PostgREST verifies, so a signed-in browser's REST calls
// run as role "authenticated" with sub = users.id, and RLS (room_visible) sees who is asking.
const enc = new TextEncoder();
const dec = new TextDecoder();
const SECRET = Deno.env.get("JWT_SECRET") ?? Deno.env.get("SUPABASE_JWT_SECRET") ?? "";

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function hmacKey() {
  return await crypto.subtle.importKey("raw", enc.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export type Claims = { role: string; sub?: string; login?: string; exp?: number; [k: string]: unknown };

export async function signJwt(claims: Claims, ttlSeconds = 7 * 24 * 3600) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(enc.encode(JSON.stringify({ iss: "huddle", iat: now, exp: now + ttlSeconds, ...claims })));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(), enc.encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

export async function verifyJwt(token: string): Promise<Claims | null> {
  const [head, body, sig] = token.split(".");
  if (!head || !body || !sig || !SECRET) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(), unb64url(sig), enc.encode(`${head}.${body}`));
    if (!ok) return null;
    const c = JSON.parse(dec.decode(unb64url(body))) as Claims;
    if (c.exp && c.exp < Date.now() / 1000) return null;
    return c;
  } catch {
    return null;
  }
}

export type Caller = {
  uid: number | null; login?: string; service: boolean;
  email?: string;      // signed in with an email code (private huddles)
  guestRoom?: string;  // was in the room when it went private; may stay until the tab closes
};

/** Who is calling: a GitHub user, an email sign-in, a guest who stayed, the server itself, or nobody. */
export async function caller(req: Request): Promise<Caller> {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  return await callerFromToken(token);
}
export async function callerFromToken(token: string): Promise<Caller> {
  const c = token ? await verifyJwt(token) : null;
  if (c?.role === "service_role") return { uid: null, service: true };
  if (c?.role !== "authenticated") return { uid: null, service: false };
  return {
    uid: c.sub ? Number(c.sub) : null, login: c.login, service: false,
    email: typeof c.email === "string" ? c.email : undefined,
    guestRoom: typeof c.guest_room === "string" ? c.guest_room : undefined,
  };
}

export const normEmail = (e: unknown) => String(e ?? "").trim().toLowerCase();
export const validEmail = (e: string) => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(e) && e.length <= 254;

// Members-only files: a per-room key that changes daily. Uploads in private rooms are served only with it.
export async function fileKey(room: string, daysAgo = 0) {
  const day = Math.floor(Date.now() / 86_400_000) - daysAgo;
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(), enc.encode(`file:${room}:${day}`)));
  return b64url(sig).slice(0, 32);
}
export async function fileKeyOk(room: string, k: string | null) {
  return !!k && (k === await fileKey(room) || k === await fileKey(room, 1));
}
/** Huddle's own functions fetch uploads by URL; add the room's file key so private rooms' files open too.
 *  Only for a file in `room` itself, so one room can never be used to read another's files. */
export async function withFileKey(url: string, room: string) {
  // Only for this Huddle's own storage: never hand a room's key to another server.
  const site = (Deno.env.get("PUBLIC_SITE_URL") ?? "").replace(/\/$/, "");
  const inner = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
  const own = [site, inner].filter(Boolean).map((u) => u + "/storage/");
  if (!own.some((o) => url.startsWith(o))) return url;
  const m = url.match(/\/storage\/v1\/object\/public\/board\/([^/?#]+)\//);
  if (!m || decodeURIComponent(m[1]) !== room || /[?&]k=/.test(url)) return url;
  // Read our own files over the internal address, not back out through the public site.
  const local = site && inner && url.startsWith(`${site}/storage/`) ? inner + url.slice(site.length) : url;
  return `${local}${local.includes("?") ? "&" : "?"}k=${await fileKey(room)}`;
}

// AES-GCM for GitHub tokens at rest; the key is derived from the JWT secret.
async function aesKey() {
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(`huddle-token-key:${SECRET}`));
  return await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function encryptSecret(plain: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(), enc.encode(plain)));
  return `${b64url(iv)}.${b64url(ct)}`;
}
export async function decryptSecret(stored: string) {
  const [iv, ct] = stored.split(".");
  return dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64url(iv) }, await aesKey(), unb64url(ct)));
}
