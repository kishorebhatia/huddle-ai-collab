// Writes aws/.env with fresh DB passwords, a JWT secret, and anon/service_role keys signed with it.
// Usage: GEMINI_API_KEY=... PUBLIC_SITE_URL=https://xxx.cloudfront.net node aws/gen-env.mjs
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";

const out = new URL("./.env", import.meta.url);
if (existsSync(out) && !process.argv.includes("--force")) {
  console.error("aws/.env exists (pass --force to regenerate; the DB keeps its old passwords)");
  process.exit(1);
}
const rand = () => randomBytes(24).toString("base64url");
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const secret = randomBytes(32).toString("hex");
const jwt = (role) => {
  const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ role, iss: "huddle", iat: 1760000000, exp: 2000000000 })}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
};
const vars = {
  PG_PASSWORD: rand(),
  AUTHENTICATOR_PASSWORD: rand(),
  JWT_SECRET: secret,
  SUPABASE_ANON_KEY: jwt("anon"),
  SUPABASE_SERVICE_ROLE_KEY: jwt("service_role"),
  GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? "",
  PUBLIC_SITE_URL: process.env.PUBLIC_SITE_URL ?? "",
};
writeFileSync(out, Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
console.log("wrote aws/.env");
