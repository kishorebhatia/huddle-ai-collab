// Secrets a build needs. Stored encrypted (room_secrets, or user_secrets for a signed-in owner), handed
// only to the Daytona sandbox that runs the build, and scrubbed from traces by value. They never enter
// the stream, a prompt, a repository or a log line.
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { decryptSecret, encryptSecret } from "./auth.ts";

export const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;

// deno-lint-ignore no-explicit-any
const G = globalThis as any;
const known: Set<string> = (G.__huddleSecretValues ??= new Set<string>());
/** Remember a value so trace export replaces it with [secret] wherever it shows up. */
export const registerSecret = (v: string) => { if (v && v.length >= 8) known.add(v); };
export function scrub(s: string) {
  let out = s;
  for (const v of known) if (out.includes(v)) out = out.split(v).join("[secret]");
  return out;
}

export async function setRoomSecret(sb: SupabaseClient, room: string, name: string, value: string, userId?: number | null) {
  await sb.from("room_secrets").upsert({
    room_id: room, name, value_enc: await encryptSecret(value), set_by: userId ?? null, updated_at: new Date().toISOString(),
  });
}
export async function setUserSecret(sb: SupabaseClient, userId: number, name: string, value: string) {
  await sb.from("user_secrets").upsert({ user_id: userId, name, value_enc: await encryptSecret(value), updated_at: new Date().toISOString() });
}

/** Server environment keys (set by an admin from the operator room) that the server doesn't have yet. */
export async function serverKeysMissing(sb: SupabaseClient, names: string[]) {
  if (!names.length) return [];
  const { data } = await sb.from("server_secrets").select("name").in("name", names);
  const stored = new Set((data ?? []).map((r: { name: string }) => r.name));
  return names.filter((n) => !Deno.env.get(n) && !stored.has(n));
}

export async function setServerSecret(sb: SupabaseClient, name: string, value: string, userId: number) {
  await sb.from("server_secrets").upsert({ name, value_enc: await encryptSecret(value), set_by: userId, updated_at: new Date().toISOString() });
  Deno.env.set(name, value); // this server process uses it right away; a restart loads it from the table
  registerSecret(value);
}

/** Which of `names` this room can use: its own secrets first, then its owner's saved ones. */
export async function secretNames(sb: SupabaseClient, room: string, names: string[]) {
  if (!names.length) return { have: [] as string[], missing: [] as string[] };
  const { data: r } = await sb.from("rooms").select("owner_id").eq("id", room).maybeSingle();
  const { data: rs } = await sb.from("room_secrets").select("name").eq("room_id", room).in("name", names);
  const { data: us } = r?.owner_id ? await sb.from("user_secrets").select("name").eq("user_id", r.owner_id).in("name", names) : { data: [] };
  const have = new Set([...(rs ?? []), ...(us ?? [])].map((x: { name: string }) => x.name));
  return { have: names.filter((n) => have.has(n)), missing: names.filter((n) => !have.has(n)) };
}

/** Decrypted values for the build sandbox. */
export async function resolveSecrets(sb: SupabaseClient, room: string, names: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!names.length) return out;
  const { data: r } = await sb.from("rooms").select("owner_id").eq("id", room).maybeSingle();
  const { data: us } = r?.owner_id ? await sb.from("user_secrets").select("name, value_enc").eq("user_id", r.owner_id).in("name", names) : { data: [] };
  const { data: rs } = await sb.from("room_secrets").select("name, value_enc").eq("room_id", room).in("name", names);
  for (const row of [...(us ?? []), ...(rs ?? [])] as { name: string; value_enc: string }[]) {
    out[row.name] = await decryptSecret(row.value_enc);
    registerSecret(out[row.name]);
  }
  return out;
}
