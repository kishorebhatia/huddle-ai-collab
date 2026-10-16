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

/** Wait for CI's `evals` check on a pull request's head commit. */
export async function waitForChecks(token: string, prNumber: number, timeoutMs = 10 * 60_000) {
  const api = gh(token);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pr = await api(`/repos/${REPO}/pulls/${prNumber}`);
    const runs = await api(`/repos/${REPO}/commits/${pr.head.sha}/check-runs`);
    // deno-lint-ignore no-explicit-any
    const evals = (runs.check_runs ?? []).find((c: any) => c.name === "evals");
    if (evals?.status === "completed") return { conclusion: evals.conclusion as string, url: evals.html_url as string, sha: pr.head.sha as string, mergeable: pr.mergeable as boolean | null };
    await new Promise((r) => setTimeout(r, 15_000));
  }
  return { conclusion: "timed_out", url: "", sha: "", mergeable: null };
}

/** Squash-merge a pull request (the push to the branch then runs CI again, which deploys). */
export async function mergePr(token: string, prNumber: number, title: string) {
  const r = await gh(token)(`/repos/${REPO}/pulls/${prNumber}/merge`, {
    method: "PUT", body: JSON.stringify({ merge_method: "squash", commit_title: `${title} (#${prNumber})` }),
  });
  return { sha: r.sha as string, merged: !!r.merged };
}

// ---------- operator v2: any change to Huddle ----------

/** Files that always wait for a human merge, even in Full auto. */
const SENSITIVE = [
  /^\.github\//, /^\.gitignore$/, /^aws\/(autodeploy\.sh|docker-compose\.yml|gen-env\.mjs|db\/)/, /^aws\/server\/(auth|mcp)\.ts$/,
  /^supabase\/functions\/_shared\/(auth|vault|secrets|operator)\.ts$/, /^supabase\/functions\/(secrets|github)\//,
];
export function sensitiveFiles(files: Record<string, string>, deleted: string[]) {
  const out = [...Object.keys(files), ...deleted].filter((p) => SENSITIVE.some((re) => re.test(p)));
  // Migrations that change who can see what (policies, grants) are sensitive too.
  for (const [p, c] of Object.entries(files)) {
    if (p.startsWith("supabase/migrations/") && /\b(policy|grant|revoke|row level security)\b/i.test(c)) out.push(p);
  }
  return [...new Set(out)];
}

/** Every tracked path on the branch, and the commit it was read at. */
export async function repoTree(token: string) {
  const api = gh(token);
  const ref = await api(`/repos/${REPO}/git/ref/heads/${BRANCH}`);
  const t = await api(`/repos/${REPO}/git/trees/${ref.object.sha}?recursive=1`);
  // deno-lint-ignore no-explicit-any
  const paths = (t.tree ?? []).filter((x: any) => x.type === "blob").map((x: any) => x.path as string);
  return { sha: ref.object.sha as string, paths };
}

export async function readFiles(sha: string, paths: string[]) {
  const out: Record<string, string> = {};
  await Promise.all(paths.map(async (p) => {
    const r = await fetch(`https://raw.githubusercontent.com/${REPO}/${sha}/${p}`);
    if (r.ok) out[p] = await r.text();
  }));
  return out;
}

/** Apply the model's output (edit / file / DELETE blocks) to the files it read. */
export function applyChange(text: string, current: Record<string, string>) {
  const files: Record<string, string> = {};
  const errors: string[] = [];
  const get = (p: string) => files[p] ?? current[p];
  for (const m of text.matchAll(/```file:([^\s`]+)\s*\n([\s\S]*?)```/g)) files[m[1].replace(/^\/+/, "")] = m[2].replace(/\n$/, "") + "\n";
  for (const m of text.matchAll(/```edit:([^\s`]+)\s*\n([\s\S]*?)```/g)) {
    const path = m[1].replace(/^\/+/, "");
    const blocks = [...m[2].matchAll(/<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n?>>>>>>> REPLACE/g)];
    let body = get(path);
    if (body === undefined) { errors.push(`${path}: not read, so it can't be edited (create it with a file block)`); continue; }
    for (const b of blocks) {
      const hits = body.split(b[1]).length - 1;
      if (hits !== 1) { errors.push(`${path}: SEARCH text found ${hits} times (needs exactly 1): ${b[1].slice(0, 120)}`); continue; }
      body = body.replace(b[1], b[2]);
    }
    files[path] = body;
  }
  const deleted = [...text.matchAll(/^DELETE:\s*(\S+)/gm)].map((m) => m[1]);
  const notes = (tag: string) => [...text.matchAll(new RegExp(`^${tag}:\\s*(.+)$`, "gim"))].map((m) => m[1].trim());
  for (const p of Object.keys(files)) if (/(^|\/)\.env$/.test(p) || p.includes("..")) { delete files[p]; errors.push(`${p}: not allowed`); }
  return { files, deleted, errors, changes: notes("CHANGE"), manual: notes("MANUAL"), verify: notes("VERIFY")[0] ?? "" };
}

/** Clone the branch in Daytona, apply the change, and run the same checks CI runs (plus the UI's JS). */
export function verifyChange(files: Record<string, string>, deleted: string[]): Promise<{ ok: boolean; log: string }> {
  return span("daytona.verify_change", "TOOL", { "tool.name": "verify change", "input.value": [...Object.keys(files), ...deleted.map((d) => `-${d}`)].join("\n") }, async (s) => {
    let sb: Sandbox | null = await findSandbox("operator");
    if (!sb) sb = await deploySandbox({ role: "operator" });
    const setup = `bash -lc "test -x ${DENO} || (curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/home/daytona/.deno-${DENO_VERSION} sh -s -- -y v${DENO_VERSION} >/dev/null 2>&1); ` +
      `rm -rf /home/daytona/repo && git clone -q --depth 1 -b ${BRANCH} https://github.com/${REPO}.git /home/daytona/repo && echo READY"`;
    const ready = await exec(sb, setup, 180);
    if (!ready.result.includes("READY")) return { ok: false, log: `setup failed: ${ready.result.slice(0, 500)}` };
    for (const [p, c] of Object.entries(files)) await upload(sb, p, c, "/home/daytona/repo");
    if (deleted.length) await exec(sb, `bash -lc "cd /home/daytona/repo && rm -f ${deleted.map((d) => `'${d}'`).join(" ")}"`, 30);
    const checks = [
      `${DENO} check aws/server/main.ts supabase/functions/*/index.ts evals/run.ts`,
      `for f in web/*.js; do node --check "$f" || exit 1; done`,
    ].join(" && ");
    const r = await exec(sb, `bash -lc "cd /home/daytona/repo && (${checks.replace(/"/g, '\\"')}) 2>&1 | tail -40; echo EXIT=\\\${PIPESTATUS[0]}"`, 300);
    const ok = /EXIT=0\s*$/.test(r.result.trim());
    s.set({ "output.value": r.result.slice(-2000), metadata: { ok } });
    return { ok, log: r.result.replace(/\x1b\[[0-9;]*m/g, "").slice(-3000) };
  });
}

/** One commit with every changed, new and deleted file, on a new branch, and a PR against the working branch. */
export async function openPrFiles(token: string, files: Record<string, string>, deleted: string[], baseSha: string, title: string, body: string) {
  const api = gh(token);
  const base = await api(`/repos/${REPO}/git/commits/${baseSha}`);
  const tree = await api(`/repos/${REPO}/git/trees`, {
    method: "POST",
    body: JSON.stringify({
      base_tree: base.tree.sha,
      tree: [
        ...Object.entries(files).map(([path, content]) => ({ path, mode: "100644", type: "blob", content })),
        ...deleted.map((path) => ({ path, mode: "100644", type: "blob", sha: null })),
      ],
    }),
  });
  const commit = await api(`/repos/${REPO}/git/commits`, {
    method: "POST", body: JSON.stringify({ message: `${title}\n\nProposed by Huddle's operator room.`, tree: tree.sha, parents: [baseSha] }),
  });
  const branch = `huddle/change-${Date.now().toString(36)}`;
  await api(`/repos/${REPO}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }) });
  const pr = await api(`/repos/${REPO}/pulls`, { method: "POST", body: JSON.stringify({ title, head: branch, base: BRANCH, body }) });
  return { url: pr.html_url as string, number: pr.number as number, branch };
}

/** Wait for the deploy run that CI starts on the branch after a merge. */
export async function waitForDeploy(token: string, sha: string, timeoutMs = 10 * 60_000) {
  const api = gh(token);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runs = await api(`/repos/${REPO}/actions/runs?head_sha=${sha}&event=push&per_page=5`);
    // deno-lint-ignore no-explicit-any
    const run = (runs.workflow_runs ?? []).find((r: any) => r.name === "evals");
    if (run?.status === "completed") return { conclusion: run.conclusion as string, url: run.html_url as string };
    await new Promise((r) => setTimeout(r, 15_000));
  }
  return { conclusion: "timed_out", url: "" };
}

/** Undo a merged change: a new commit on the branch whose tree is the one before the merge. */
export async function revertMerge(token: string, mergeSha: string, reason: string) {
  const api = gh(token);
  const merged = await api(`/repos/${REPO}/git/commits/${mergeSha}`);
  const parent = await api(`/repos/${REPO}/git/commits/${merged.parents[0].sha}`);
  const head = await api(`/repos/${REPO}/git/ref/heads/${BRANCH}`);
  // Restoring the old tree would also undo anything pushed after the merge, so only revert our own tip.
  if (head.object.sha !== mergeSha) return null;
  const commit = await api(`/repos/${REPO}/git/commits`, {
    method: "POST",
    body: JSON.stringify({ message: `Revert ${mergeSha.slice(0, 7)}: ${reason}\n\nReverted by Huddle's operator room after the post-deploy check failed.`, tree: parent.tree.sha, parents: [head.object.sha] }),
  });
  await api(`/repos/${REPO}/git/refs/heads/${BRANCH}`, { method: "PATCH", body: JSON.stringify({ sha: commit.sha }) });
  return commit.sha as string | null;
}
