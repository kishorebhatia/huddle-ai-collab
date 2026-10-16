// Huddle improving Huddle. The operator room's pipelines read production evidence, change prompts.ts,
// type-check the whole repo in a Daytona sandbox, and open a pull request with the admin's GitHub token.
// CI's eval gate runs on the PR, and only a human merges it (merging deploys).
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { decryptSecret } from "./auth.ts";
import { deploySandbox, exec, findSandbox, upload, type Sandbox } from "./daytona.ts";
import { span } from "./trace.ts";

export const REPO = Deno.env.get("SELF_REPO") ?? "kishorebhatia/huddle-ai-collab";
export const BRANCH = Deno.env.get("SELF_BRANCH") ?? "redesign-v4";
export const PROMPTS_PATH = "supabase/functions/_shared/prompts.ts";
const DENO_VERSION = "2.1.4";
const DENO = `/home/daytona/.deno-${DENO_VERSION}/bin/deno`;

/** Low scores, lessons and failures from the last day, as plain text for the model. */
export async function evidence(sb: SupabaseClient) {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const [{ data: evals }, { data: lessons }, { data: fails }] = await Promise.all([
    sb.from("evals").select("name, score, explanation, room_id").lt("score", 0.7).gte("created_at", since).neq("room_id", "ci").order("id", { ascending: false }).limit(25),
    sb.from("lessons").select("stage, text, eval_name, score").order("id", { ascending: false }).limit(15),
    sb.from("events").select("text").eq("kind", "system").like("text", "Failed:%").gte("created_at", since).order("id", { ascending: false }).limit(10),
  ]);
  return `LOW EVAL SCORES (last 24h):\n${(evals ?? []).map((e) => `- ${e.name} ${Number(e.score).toFixed(2)}: ${(e.explanation ?? "").slice(0, 300)}`).join("\n") || "(none)"}\n\n` +
    `LESSONS HUDDLE LEARNED:\n${(lessons ?? []).map((l) => `- [${l.stage}, from ${l.eval_name} ${Number(l.score).toFixed(2)}] ${l.text}`).join("\n") || "(none)"}\n\n` +
    `FAILED PIPELINES:\n${(fails ?? []).map((f) => `- ${(f.text ?? "").slice(0, 250)}`).join("\n") || "(none)"}`;
}

/** The admin's GitHub token (they signed in with GitHub). */
export async function adminToken(sb: SupabaseClient) {
  const admins = (Deno.env.get("ADMIN_LOGINS") ?? "kishorebhatia").toLowerCase().split(",").map((x) => x.trim());
  const { data } = await sb.from("users").select("login, token_enc").not("token_enc", "is", null);
  const admin = (data ?? []).find((u) => admins.includes(u.login.toLowerCase()));
  if (!admin) throw new Error(`The admin (${admins.join(", ")}) must sign in with GitHub once before Huddle can open pull requests`);
  return { login: admin.login, token: await decryptSecret(admin.token_enc) };
}

function gh(token: string) {
  return async (path: string, init: RequestInit = {}) => {
    const r = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "huddle", ...(init.body ? { "content-type": "application/json" } : {}) },
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`GitHub ${path} ${r.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  };
}

/** prompts.ts as it is on the branch right now, and its blob sha. */
export async function currentPrompts(token: string) {
  const f = await gh(token)(`/repos/${REPO}/contents/${PROMPTS_PATH}?ref=${BRANCH}`);
  const bytes = Uint8Array.from(atob(String(f.content).replace(/\n/g, "")), (c) => c.charCodeAt(0));
  return { content: new TextDecoder().decode(bytes), sha: f.sha as string };
}

/** Type-check the whole repo with the new prompts.ts, in a reusable Daytona sandbox. */
export function typeCheck(content: string): Promise<{ ok: boolean; log: string }> {
  return span("daytona.deno_check", "TOOL", { "tool.name": "deno check", "input.value": PROMPTS_PATH }, async (s) => {
    let sb: Sandbox | null = await findSandbox("operator");
    if (!sb) sb = await deploySandbox({ role: "operator" });
    // Same Deno as CI (.github/workflows/evals.yml), so a change passes here exactly when it passes there.
    const setup = `bash -lc "test -x ${DENO} || (curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/home/daytona/.deno-${DENO_VERSION} sh -s -- -y v${DENO_VERSION} >/dev/null 2>&1); ` +
      `rm -rf /home/daytona/repo && git clone -q --depth 1 -b ${BRANCH} https://github.com/${REPO}.git /home/daytona/repo && echo READY"`;
    const ready = await exec(sb, setup, 180);
    if (!ready.result.includes("READY")) return { ok: false, log: `setup failed: ${ready.result.slice(0, 500)}` };
    await upload(sb, PROMPTS_PATH, content, "/home/daytona/repo");
    const r = await exec(sb, `bash -lc "cd /home/daytona/repo && ${DENO} check aws/server/main.ts supabase/functions/*/index.ts evals/run.ts 2>&1 | tail -40; echo EXIT=\\\${PIPESTATUS[0]}"`, 240);
    const ok = /EXIT=0\s*$/.test(r.result.trim());
    s.set({ "output.value": r.result.slice(-2000), metadata: { ok } });
    return { ok, log: r.result.replace(/\x1b\[[0-9;]*m/g, "").slice(-3000) };
  });
}

/** Branch + commit + pull request against the working branch. */
export async function openPr(token: string, content: string, baseSha: string, title: string, body: string) {
  const api = gh(token);
  const head = await api(`/repos/${REPO}/git/ref/heads/${BRANCH}`);
  const branch = `huddle/improve-${Date.now().toString(36)}`;
  await api(`/repos/${REPO}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: head.object.sha }) });
  await api(`/repos/${REPO}/contents/${PROMPTS_PATH}`, {
    method: "PUT",
    body: JSON.stringify({ message: `${title}\n\nProposed by Huddle's operator room from production evals.`, content: btoa(String.fromCharCode(...new TextEncoder().encode(content))), sha: baseSha, branch }),
  });
  const pr = await api(`/repos/${REPO}/pulls`, { method: "POST", body: JSON.stringify({ title, head: branch, base: BRANCH, body }) });
  return { url: pr.html_url as string, number: pr.number as number, branch };
}
