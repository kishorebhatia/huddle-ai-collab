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

/** Who is calling: a signed-in user, the server itself (service role), or nobody. */
export async function caller(req: Request): Promise<{ uid: number | null; login?: string; service: boolean }> {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const c = token ? await verifyJwt(token) : null;
  if (c?.role === "service_role") return { uid: null, service: true };
  if (c?.role === "authenticated" && c.sub) return { uid: Number(c.sub), login: c.login, service: false };
  return { uid: null, service: false };
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
