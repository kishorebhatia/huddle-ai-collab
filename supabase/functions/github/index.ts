// POST { room, action, ... } -> GitHub-backed rooms. The caller must be signed in with GitHub (Huddle JWT).
//   status                         who owns the room, its visibility, repo and members
//   visibility { visibility }      public | private; the first signed-in person to set it becomes the owner
//   invite { login }               owner adds a member by GitHub login (and as a collaborator on a private repo)
//   preview { transcript? }        the files a publish would write, after secret redaction
//   publish { transcript?, name? } create the repo from the template if needed, scan, commit what changed
import { cors, db, json } from "../_shared/util.ts";
import { caller, decryptSecret } from "../_shared/auth.ts";
import { gitleaks, redactPatterns, type Finding } from "../_shared/secrets.ts";
import { recordEval } from "../_shared/evals.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

const TEMPLATE = Deno.env.get("GITHUB_TEMPLATE") ?? "kishorebhatia/huddle-room-template";
// Public rooms: one repository per room in this org, created and written with the org's token (no sign-in).
const ORG = Deno.env.get("GITHUB_ORG");
const ORG_TOKEN = Deno.env.get("GITHUB_ORG_TOKEN");
const ORG_MODE = !!(ORG && ORG_TOKEN);
const ORG_TEMPLATE = Deno.env.get("GITHUB_ORG_TEMPLATE") ?? `${ORG}/huddle-room-template`;
// deno-lint-ignore no-explicit-any
const locks: Set<string> = ((globalThis as any).__huddlePublishLocks ??= new Set<string>());
const SITE = (Deno.env.get("PUBLIC_SITE_URL") ?? "").replace(/\/$/, "");

// deno-lint-ignore no-explicit-any
type Any = any;

const slug = (s: string, n = 40) =>
  (s || "untitled").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, n) || "untitled";
async function sha256(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function gh(token: string) {
  return async (path: string, init: RequestInit = {}): Promise<Any> => {
    const r = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28",
        "user-agent": "huddle", ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}),
      },
    });
    const text = await r.text();
    const body = text ? JSON.parse(text) : {};
    if (!r.ok) throw Object.assign(new Error(`GitHub ${path} ${r.status}: ${body.message ?? text.slice(0, 200)}`), { status: r.status });
    return body;
  };
}

// ---------- the room as files ----------
const list = (items: Any[] | undefined, f: (x: Any) => string) => (items?.length ? items.map((x) => `- ${f(x)}`).join("\n") : "_None yet._");

async function buildFiles(sb: SupabaseClient, room: Any, opts: { transcript: boolean }) {
  const id = room.id;
  const [{ data: brain }, { data: jobs }, { data: pipes }, { data: members }] = await Promise.all([
    sb.from("brain").select("state, locked, updated_at").eq("room_id", id).maybeSingle(),
    sb.from("jobs").select("id, kind, title, status, output_md, output_html, sources, pipeline_id, meta, updated_at").eq("room_id", id).eq("status", "done").order("id"),
    sb.from("pipelines").select("id, title, goal, status, host_url").eq("room_id", id).order("id"),
    sb.from("room_members").select("login, role").eq("room_id", id),
  ]);
  const s = brain?.state ?? {};
  const name = room.name || `Huddle ${id}`;
  const files: Record<string, string> = {};

  files["BRIEF.md"] = `# ${name}: brief\n\n_Updated ${brain?.updated_at ?? "never"} by Huddle._\n\n` +
    `**Goal:** ${s.goal ?? "_not set_"}\n\n${s.summary ?? ""}\n\n## Decisions\n${list(s.decisions, (d) => d.text + (d.by ? ` (${d.by})` : ""))}\n\n` +
    `## Open questions\n${list(s.questions, (q) => q.text)}\n\n## Ideas\n${list(s.ideas, (i) => i.text)}\n\n` +
    `## Next steps\n${list(s.next_steps, (n) => `${n.text}${n.owner ? ` (${n.owner})` : ""}`)}\n`;

  (brain?.locked ?? []).forEach((d: Any, i: number) => {
    files[`decisions/${String(i + 1).padStart(3, "0")}-${slug(d.text)}.md`] =
      `# ${d.text}\n\nLocked by ${d.by ?? "the team"} in Huddle. Later brief updates keep it word for word.\n`;
  });

  const byPipe = new Map<number, Any[]>();
  for (const j of jobs ?? []) if (j.pipeline_id) byPipe.set(j.pipeline_id, [...(byPipe.get(j.pipeline_id) ?? []), j]);
  const deployRows: string[] = [];
  const protoLinks: { name: string; path: string; title: string }[] = [];
  const used = new Set<string>();
  const uniq = (base: string) => { let n = base, i = 2; while (used.has(n)) n = `${base}-${i++}`; used.add(n); return n; };

  const units = [
    ...(pipes ?? []).map((p: Any) => ({ title: p.title, goal: p.goal, host: p.host_url, jobs: byPipe.get(p.id) ?? [] })),
    ...(jobs ?? []).filter((j: Any) => !j.pipeline_id).map((j: Any) => ({ title: j.title, goal: "", host: null, jobs: [j] })),
  ];
  for (const u of units) {
    const last = (k: string) => [...u.jobs].reverse().find((j: Any) => j.kind === k);
    const research = last("research"), proto = last("prototype"), host = last("host");
    if (!research && !proto) continue;
    const key = uniq(slug(u.title));
    if (research) {
      files[`research/${key}.md`] = `# ${research.title}\n\n${research.output_md ?? ""}\n\n## Sources\n` +
        list(research.sources, (x) => `[${x.title}](${x.url})${x.read_by_anchor ? " (read by Anchor)" : ""}`) + "\n";
    }
    if (proto?.output_html) {
      files[`prototypes/${key}/index.html`] = proto.output_html;
      const ev = { ...(proto.meta?.evals ?? {}), ...(host?.meta?.evals ?? {}) };
      const evText = Object.entries(ev).map(([k, v]: Any) => `${k} ${Number(v.score).toFixed(2)}`).join(" · ") || "none";
      files[`prototypes/${key}/README.md`] = `# ${proto.title}\n\n${proto.output_md ?? ""}\n\n` +
        (u.goal ? `**Built for:** ${u.goal}\n\n` : "") + (u.host ? `**Live:** ${u.host}\n\n` : "") + `**Evals:** ${evText}\n`;
      protoLinks.push({ name: key, path: `prototypes/${key}/`, title: proto.title });
      const smoke = host?.meta?.smoke;
      deployRows.push(`| [${proto.title}](prototypes/${key}/) | ${u.host ?? "not hosted"} | ${smoke ? (smoke.works ? "passed" : "failed") : "not run"} | ${evText} |`);
    }
  }

  files["deploy.md"] = `# Where things are live\n\n| Prototype | Live URL | Anchor smoke test | Evals |\n|---|---|---|---|\n` +
    (deployRows.join("\n") || "| _None yet_ | | | |") +
    `\n\nDaytona sandboxes stop after two idle hours. On public repositories GitHub Pages serves the same code permanently.\n`;

  files["index.html"] = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${name.replace(/</g, "&lt;")}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px}</style>` +
    `<h1>${name.replace(/</g, "&lt;")}</h1><p>Prototypes built in this Huddle room:</p><ul>` +
    (protoLinks.map((p) => `<li><a href="${p.path}">${p.title.replace(/</g, "&lt;")}</a></li>`).join("") || "<li>None yet</li>") +
    `</ul><p><a href="BRIEF.md">Brief</a> · <a href="deploy.md">Deploys</a></p>`;

  files["README.md"] = `# ${name}\n\nThis repository backs the Huddle room [${id}](${SITE}/?room=${encodeURIComponent(id)}). ` +
    `Huddle writes it each time someone presses **Publish to GitHub**.\n\n` +
    `- [Brief](BRIEF.md): goal, decisions, questions and next steps\n- [Deploys](deploy.md): live URLs, smoke tests and eval scores\n` +
    (protoLinks.length ? `- Prototypes:\n${protoLinks.map((p) => `  - [${p.title}](${p.path})`).join("\n")}\n` : "") +
    (Object.keys(files).some((f) => f.startsWith("research/")) ? `- [Research](research/)\n` : "") +
    (members?.length ? `\n**Members:** ${members.map((m: Any) => `@${m.login}`).join(", ")}\n` : "");

  if (opts.transcript) {
    const { data: evs } = await sb.from("events").select("id, author, kind, text, created_at").eq("room_id", id)
      .eq("forgotten", false).in("kind", ["speech", "note", "link", "finding", "feedback", "voice"])
      // Only what's older than the 2-minute "forget" window.
      .lt("created_at", new Date(Date.now() - 120_000).toISOString()).order("id").limit(2000);
    files["transcript/stream.md"] = `# Stream\n\n` + (evs ?? []).map((e: Any) => `**${e.author}** (${e.kind}, ${e.created_at}): ${e.text ?? ""}`).join("\n\n") + "\n";
  }
  return files;
}

async function scan(files: Record<string, string>) {
  const p = redactPatterns(files);
  const g = await gitleaks(p.files);
  const findings: Finding[] = [...p.findings, ...g.findings];
  return { files: g.files, findings, note: g.note, gitleaksRan: g.ran };
}

// ---------- handler ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const who = await caller(req);
    const body = await req.json().catch(() => ({}));
    const { room: roomId, action } = body;
    if (!roomId || !action) return json({ error: "room and action required" }, 400);
    const sb = db();
    const { data: user } = who.uid ? await sb.from("users").select("*").eq("id", who.uid).maybeSingle() : { data: null };
    if (who.uid && !user) return json({ error: "unknown user; sign in again", need_signin: true }, 401);
    await sb.from("rooms").upsert({ id: roomId }, { onConflict: "id", ignoreDuplicates: true });
    let { data: room } = await sb.from("rooms").select("*").eq("id", roomId).single();
    const { data: members } = await sb.from("room_members").select("login, role, user_id").eq("room_id", roomId);
    const isOwner = !!user && room.owner_id === user.id;
    const isMember = isOwner || (!!user && (members ?? []).some((m: Any) => m.user_id === user.id));
    if (room.visibility === "private" && !isMember && !who.service) return json({ error: "This huddle is private" }, 403);
    // Public rooms are backed by the org with no sign-in. Signing in is for private rooms (and their settings).
    const settings = action === "visibility" || action === "invite";
    if ((settings || room.visibility === "private" || !ORG_MODE) && !user && !who.service) {
      return json({ error: "Sign in with GitHub first", need_signin: true }, 401);
    }

    if (action === "status") {
      const { data: owner } = room.owner_id ? await sb.from("users").select("login, avatar_url").eq("id", room.owner_id).single() : { data: null };
      return json({ org_mode: ORG_MODE, org: ORG, owner, visibility: room.visibility, repo: room.repo, members, is_owner: isOwner, signed_in: !!user });
    }

    if (settings || (room.visibility === "private" && !who.service)) {
      // Changing a room: owner only (an unowned room is claimed by the first signed-in person to act).
      if (room.owner_id && !isOwner) {
        const { data: owner } = await sb.from("users").select("login").eq("id", room.owner_id).single();
        return json({ error: `Only @${owner?.login} can change this huddle's GitHub settings` }, 403);
      }
      if (!room.owner_id && user) {
        await sb.from("rooms").update({ owner_id: user.id }).eq("id", roomId);
        await sb.from("room_members").upsert({ room_id: roomId, login: user.login, user_id: user.id, role: "owner" });
        room = { ...room, owner_id: user.id };
      }
    }

    // Org repos use the org's token; repos made in someone's own account (before org mode) use the owner's.
    const repoOwner: string = room.repo?.owner ?? (ORG_MODE ? ORG! : user!.login);
    const useOrg = ORG_MODE && repoOwner === ORG;
    let token = useOrg ? ORG_TOKEN! : "";
    if (!token) {
      const { data: owner } = room.owner_id ? await sb.from("users").select("token_enc").eq("id", room.owner_id).maybeSingle() : { data: user };
      token = owner?.token_enc ? await decryptSecret(owner.token_enc) : "";
    }
    if (!token) return json({ error: "Sign in with GitHub first", need_signin: true }, 401);
    const api = gh(token);
    const addCollaborators = async (repo: Any) => {
      const { data: ms } = await sb.from("room_members").select("login, role").eq("room_id", roomId);
      for (const m of ms ?? []) {
        if (!useOrg && m.login.toLowerCase() === repoOwner.toLowerCase()) continue;
        await api(`/repos/${repo.owner}/${repo.name}/collaborators/${m.login}`, {
          method: "PUT", body: JSON.stringify({ permission: m.role === "owner" ? "admin" : "push" }),
        }).catch((e) => console.warn("collaborator", e));
      }
    };

    if (action === "visibility") {
      const vis = body.visibility === "private" ? "private" : "public";
      if (vis === "private" && !useOrg && !user.scopes.split(",").includes("repo")) return json({ need_scope: "private" });
      if (room.repo?.name) {
        if (vis === "public" && !body.confirm_public) return json({ confirm_public: true, repo: room.repo });
        await api(`/repos/${room.repo.owner}/${room.repo.name}`, { method: "PATCH", body: JSON.stringify({ private: vis === "private" }) });
        if (vis === "private") await addCollaborators(room.repo);
      }
      await sb.from("rooms").update({ visibility: vis, repo: room.repo ? { ...room.repo, private: vis === "private" } : null }).eq("id", roomId);
      await sb.from("events").insert({ room_id: roomId, author: "huddle", kind: "system",
        text: vis === "private"
          ? `@${user.login} made this huddle private. Only invited GitHub users can open it${room.repo ? `, and its repository is now private` : ""}.`
          : `@${user.login} made this huddle public.` });
      return json({ visibility: vis });
    }

    if (action === "invite") {
      const login = String(body.login ?? "").replace(/^@/, "").trim();
      if (!/^[a-z\d](?:[a-z\d-]{0,38})$/i.test(login)) return json({ error: "That isn't a GitHub username" }, 400);
      const ghUser = await api(`/users/${login}`).catch(() => null);
      if (!ghUser) return json({ error: `No GitHub user @${login}` }, 404);
      const { data: known } = await sb.from("users").select("id").eq("github_id", ghUser.id).maybeSingle();
      await sb.from("room_members").upsert({ room_id: roomId, login: ghUser.login, user_id: known?.id ?? null, role: "member" });
      if (room.repo?.private) {
        await api(`/repos/${room.repo.owner}/${room.repo.name}/collaborators/${ghUser.login}`, { method: "PUT", body: JSON.stringify({ permission: "push" }) })
          .catch((e) => console.warn("collaborator", e));
      }
      return json({ invited: ghUser.login });
    }

    if (action === "preview" || action === "publish") {
      // Automatic saves wait until the room has made something worth a repository.
      if (body.auto) {
        const { count } = await sb.from("jobs").select("id", { count: "exact", head: true }).eq("room_id", roomId)
          .eq("status", "done").in("kind", ["research", "prototype"]);
        if (!count) return json({ skipped: "nothing to publish yet" });
      }
      if (action === "publish") {
        if (locks.has(roomId)) return json({ skipped: "a publish is already running" });
        locks.add(roomId);
      }
      try {
      const raw = await buildFiles(sb, room, { transcript: !!body.transcript });
      const scanned = await scan(raw);
      const repoName = room.repo?.name ?? (useOrg
        ? `${slug(room.name || "huddle", 40)}-${slug(roomId, 24)}` // unique per room inside the org
        : slug(body.name || room.name || `huddle-${roomId}`, 60));
      const { data: known } = await sb.from("repo_files").select("path, sha256").eq("room_id", roomId);
      const prev = new Map((known ?? []).map((f: Any) => [f.path, f.sha256]));
      const hashes = Object.fromEntries(await Promise.all(Object.entries(scanned.files).map(async ([p, t]) => [p, await sha256(t)])));
      const changed = Object.keys(scanned.files).filter((p) => prev.get(p) !== hashes[p]);
      const target = { owner: repoOwner, name: repoName, private: room.visibility === "private", exists: !!room.repo };

      if (action === "preview") {
        return json({
          target, note: scanned.note, findings: scanned.findings,
          files: Object.entries(scanned.files).map(([path, t]) => ({ path, bytes: t.length, changed: changed.includes(path) })),
        });
      }

      // ----- publish -----
      if (!changed.length) return json({ up_to_date: true, repo: room.repo });
      let repo = room.repo;
      if (!repo) {
        let created: Any = null;
        for (const name of [repoName, `${repoName}-${roomId}`.slice(0, 90)]) {
          try {
            created = await api(`/repos/${useOrg ? ORG_TEMPLATE : TEMPLATE}/generate`, {
              method: "POST",
              body: JSON.stringify({ owner: repoOwner, name, private: target.private, description: `Huddle room: ${room.name || roomId}${SITE ? ` · ${SITE}/?room=${roomId}` : ""}` }),
            });
            break;
          } catch (e) {
            if ((e as Any).status !== 422) throw e; // 422: name taken, try the longer one
          }
        }
        if (!created) throw new Error("couldn't create the repository (name taken?)");
        repo = { owner: created.owner.login, name: created.name, id: created.id, html_url: created.html_url, private: created.private, pages_url: null };
        // The template's first commit lands asynchronously.
        for (let i = 0; i < 20; i++) {
          if (await api(`/repos/${repo.owner}/${repo.name}/git/ref/heads/main`).catch(() => null)) break;
          await new Promise((r) => setTimeout(r, 1000));
        }
        if (!repo.private) {
          const pages = await api(`/repos/${repo.owner}/${repo.name}/pages`, { method: "POST", body: JSON.stringify({ build_type: "workflow" }) })
            .catch((e) => (console.warn("pages", e), null));
          repo.pages_url = pages?.html_url ?? null;
        }
        if (repo.private) await addCollaborators(repo);
      }
      const base = `/repos/${repo.owner}/${repo.name}`;
      const ref = await api(`${base}/git/ref/heads/main`);
      const parent = await api(`${base}/git/commits/${ref.object.sha}`);
      const tree = await api(`${base}/git/trees`, {
        method: "POST",
        body: JSON.stringify({ base_tree: parent.tree.sha, tree: changed.map((path) => ({ path, mode: "100644", type: "blob", content: scanned.files[path] })) }),
      });
      // Credit everyone in the room who signed in with GitHub.
      const ids = [user?.id, ...(members ?? []).map((m: Any) => m.user_id)].filter(Boolean);
      const { data: people } = ids.length ? await sb.from("users").select("github_id, login, name").in("id", ids) : { data: [] };
      const noreply = (u: Any) => `${u.github_id}+${u.login}@users.noreply.github.com`;
      const trailers = (people ?? []).filter((p: Any) => p.login !== user?.login).map((p: Any) => `Co-authored-by: ${p.name || p.login} <${noreply(p)}>`);
      // Signed-in publishers author their commits; automatic saves are authored by Huddle.
      const author = user ? { name: user.name || user.login, email: noreply(user) } : { name: "Huddle", email: "huddle-bot@users.noreply.github.com" };
      const commit = await api(`${base}/git/commits`, {
        method: "POST",
        body: JSON.stringify({
          message: `Publish from Huddle: ${changed.length} file${changed.length > 1 ? "s" : ""}\n\n${changed.map((p) => `- ${p}`).join("\n")}` +
            (scanned.findings.length ? `\n\n${scanned.findings.length} secret(s) redacted before publishing.` : "") +
            (trailers.length ? `\n\n${trailers.join("\n")}` : ""),
          tree: tree.sha, parents: [ref.object.sha],
          author: { ...author, date: new Date().toISOString() },
        }),
      });
      await api(`${base}/git/refs/heads/main`, { method: "PATCH", body: JSON.stringify({ sha: commit.sha }) });

      repo = { ...repo, last_commit: commit.sha, last_published_at: new Date().toISOString() };
      await sb.from("rooms").update({ repo }).eq("id", roomId);
      await sb.from("repo_files").upsert(changed.map((path) => ({ room_id: roomId, path, sha256: hashes[path], commit_sha: commit.sha, updated_at: new Date().toISOString() })));
      await recordEval({
        name: "secret_free", score: scanned.findings.length ? 0 : 1, room: roomId,
        explanation: scanned.findings.length
          ? `Redacted ${scanned.findings.length} secret(s) before publishing: ${[...new Set(scanned.findings.map((f) => `${f.rule} in ${f.file}`))].join(", ").slice(0, 600)}`
          : `No secrets found (${scanned.note}).`,
        task: "Publish prototypes and research to a public repository",
      });
      await sb.from("events").insert({
        room_id: roomId, author: "huddle", kind: "system",
        text: `${user ? `@${user.login} published` : "Saved"} ${changed.length} file${changed.length > 1 ? "s" : ""} to ${repo.html_url} (commit ${commit.sha.slice(0, 7)})` +
          (scanned.findings.length ? `. Redacted ${scanned.findings.length} secret(s) first.` : "."),
        meta: { github: true, commit: commit.sha },
      });
      return json({ repo, commit: commit.sha, html_url: `${repo.html_url}/commit/${commit.sha}`, changed, findings: scanned.findings, note: scanned.note });
      } finally {
        locks.delete(roomId);
      }
    }
    return json({ error: `unknown action ${action}` }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
