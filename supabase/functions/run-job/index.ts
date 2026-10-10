// POST { job_id } -> runs one job (research | review | prototype | host) in the background.
// Status streams back via Realtime; pipeline jobs hand control back to the orchestrator when done.
import { background, cors, db, FAST_MODEL, gemini, geminiJson, json, SMART_MODEL } from "../_shared/util.ts";
import { invokeFn } from "../_shared/pipeline.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

const RESEARCH_SYSTEM = `You are a fast, rigorous research agent for a small team working live.
ALWAYS run Google Search before answering, even if you think you know; every factual claim must
come from a search result. Return a tight markdown brief:
## Answer  (2-4 sentences, the direct answer with numbers and dates)
## Key findings  (5-8 bullets, each with a specific fact)
## Implications for the team  (2-4 bullets tied to their goal)
## Open questions
Prefer primary sources and recent information. Do not pad.`;

const PROTOTYPE_SYSTEM = `You are a prototyping agent. Build a working, good-looking, single-file HTML prototype.
Rules: ONE complete HTML document. Inline all CSS and JS. You may load libraries only from
https://cdn.jsdelivr.net or https://unpkg.com with exact versions. Use realistic mock data; no backend.
It must run inside a sandboxed iframe (no localStorage reliance, no alerts). Make the core interaction
actually work. Ground the content in the research and the team's conversation provided.
Keep it focused: one screen, under ~400 lines total, so it builds in well under a minute.
Return ONLY the HTML document inside one \`\`\`html code block, then one line starting
with "SUMMARY:" describing what it does and how to try it.`;

const REVIEW_SYSTEM = `You are a demanding reviewer for a small team's agent pipeline. You did NOT write the work.
Judge it against the pipeline goal and the team's conversation: does it answer what was asked, is it
correct and specific, are claims sourced (research), does the core interaction plausibly work and
match the ask (prototype)? Verdict "pass" if a busy teammate could use it as-is; "revise" only for
concrete, fixable problems — then give precise revision_instructions. Set question_for_team ONLY if a
decision genuinely belongs to the humans and blocks good work (e.g. target user, scope); else "".`;

const REVIEW_SCHEMA = {
  type: "OBJECT",
  properties: {
    verdict: { type: "STRING", enum: ["pass", "revise"] },
    score: { type: "INTEGER", description: "Quality from 1 (unusable) to 10 (excellent)." },
    strengths: { type: "ARRAY", items: { type: "STRING" } },
    issues: { type: "ARRAY", items: { type: "STRING" } },
    revision_instructions: { type: "STRING" },
    question_for_team: { type: "STRING" },
  },
  required: ["verdict", "score", "strengths", "issues", "revision_instructions", "question_for_team"],
};

function extractHtml(text: string) {
  const fenced = text.match(/```html\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const start = text.search(/<!doctype html|<html/i);
  if (start >= 0) {
    const end = text.toLowerCase().lastIndexOf("</html>");
    return text.slice(start, end > start ? end + 7 : undefined).trim();
  }
  return null;
}

const now = () => new Date().toISOString();

/** Everything an agent should know: the brief, the recent conversation, and earlier stage outputs. */
async function contextPack(sb: SupabaseClient, job: any) {
  const { data: brain } = await sb.from("brain").select("state").eq("room_id", job.room_id).maybeSingle();
  const s = brain?.state ?? {};
  const { data: recent } = await sb.from("events").select("id, author, kind, text")
    .eq("room_id", job.room_id).neq("kind", "system").order("id", { ascending: false }).limit(40);
  const convo = (recent ?? []).reverse()
    .map((e) => `[#${e.id} ${e.author} ${e.kind}] ${(e.text ?? "").slice(0, 600)}`).join("\n");

  let stageInputs = "";
  let previous: any = null;
  if (job.pipeline_id) {
    const { data: done } = await sb.from("jobs").select("id, kind, stage_index, output_md, output_html, sources")
      .eq("pipeline_id", job.pipeline_id).eq("status", "done").order("id");
    const prior = (done ?? []).filter((j) => j.stage_index < job.stage_index);
    const lastOf = (k: string) => [...prior].reverse().find((j) => j.kind === k);
    previous = [...prior].reverse().find((j) => j.stage_index === job.stage_index - 1) ?? null;
    const research = lastOf("research");
    if (research && job.kind !== "research") {
      stageInputs += `\n\nRESEARCH FROM EARLIER STAGE:\n${research.output_md ?? ""}`;
    }
  }
  const text =
    `TEAM GOAL: ${s.goal ?? "(not set)"}\nWHERE THINGS STAND: ${s.summary ?? ""}\n` +
    `DECISIONS: ${(s.decisions ?? []).map((d: any) => d.text).join("; ") || "(none)"}\n\n` +
    `RECENT CONVERSATION (transcripts, notes, sketches, findings):\n${convo || "(none)"}` + stageInputs;
  return { text, previous };
}

async function deployToVercel(html: string, name: string): Promise<string> {
  const token = Deno.env.get("VERCEL_TOKEN");
  const team = Deno.env.get("VERCEL_TEAM_ID");
  if (!token) throw new Error("VERCEL_TOKEN secret is not set");
  const q = team ? `?teamId=${team}` : "";
  const r = await fetch(`https://api.vercel.com/v13/deployments${q}${q ? "&" : "?"}skipAutoDetectionConfirmation=1`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      name, target: "production", projectSettings: { framework: null },
      files: [{ file: "index.html", data: html }],
    }),
  });
  const dep = await r.json();
  if (!r.ok) throw new Error(`Vercel ${r.status}: ${JSON.stringify(dep).slice(0, 300)}`);
  for (let i = 0; i < 30; i++) {
    const g = await fetch(`https://api.vercel.com/v13/deployments/${dep.id}${q}`, { headers: { authorization: `Bearer ${token}` } });
    const d = await g.json();
    if (d.readyState === "READY") {
      // Prefer the short production alias (project.vercel.app) over the team-suffixed one.
      const aliases: string[] = d.alias ?? [];
      const alias = aliases.find((a) => a === `${name}.vercel.app`) ?? aliases.find((a) => a.endsWith(".vercel.app")) ?? d.url;
      return `https://${alias}`;
    }
    if (d.readyState === "ERROR" || d.readyState === "CANCELED") throw new Error(`Vercel deploy ${d.readyState}`);
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error("Vercel deploy did not finish in 60 s");
}

async function run(jobId: number) {
  const sb = db();
  const { data: job } = await sb.from("jobs").select("*").eq("id", jobId).single();
  if (!job) return;
  await sb.from("jobs").update({ status: "running", error: null, updated_at: now() }).eq("id", jobId);

  try {
    const ctx = await contextPack(sb, job);
    let parentBlock = "";
    if (job.parent_id) {
      const { data: parent } = await sb.from("jobs").select("*").eq("id", job.parent_id).single();
      if (parent) {
        parentBlock = job.kind === "prototype"
          ? `\n\nPREVIOUS VERSION (revise it, keep what works):\n\`\`\`html\n${parent.output_html ?? ""}\n\`\`\``
          : `\n\nPREVIOUS VERSION (revise and extend it):\n${parent.output_md ?? ""}`;
        if (!job.pipeline_id) parentBlock += `\n\nORIGINAL TASK: ${parent.prompt}`;
      }
    }
    const userText = `${ctx.text}\n\nTASK: ${job.title}\n${job.prompt}${parentBlock}`;

    if (job.kind === "research") {
      const { text, raw } = await gemini({
        systemInstruction: { parts: [{ text: RESEARCH_SYSTEM }] },
        contents: [{ role: "user", parts: [{ text: userText }] }],
        tools: [{ google_search: {} }],
        generationConfig: { thinkingConfig: { thinkingLevel: "low" } },
      }, SMART_MODEL);
      const chunks = raw?.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
      const seen = new Set<string>();
      const sources = chunks
        .map((c: any) => c.web)
        .filter((w: any) => w?.uri && !seen.has(w.uri) && seen.add(w.uri))
        .map((w: any) => ({ title: w.title ?? w.uri, url: w.uri }));
      const note = sources.length ? "" : "\n\n> No web sources came back for this brief — treat its facts as unverified.";
      await sb.from("jobs").update({ status: "done", output_md: text + note, sources, updated_at: now() }).eq("id", jobId);
    } else if (job.kind === "prototype") {
      const { text } = await gemini({
        systemInstruction: { parts: [{ text: PROTOTYPE_SYSTEM }] },
        contents: [{ role: "user", parts: [{ text: userText }] }],
        generationConfig: { thinkingConfig: { thinkingLevel: Deno.env.get("PROTOTYPE_THINKING") ?? "low" } },
      }, SMART_MODEL);
      const html = extractHtml(text);
      if (!html) throw new Error("model returned no HTML");
      const summary = text.match(/SUMMARY:\s*(.+)/i)?.[1]?.trim() ?? "";
      await sb.from("jobs").update({ status: "done", output_html: html, output_md: summary, updated_at: now() }).eq("id", jobId);
    } else if (job.kind === "review") {
      const target = ctx.previous;
      if (!target) throw new Error("nothing to review");
      const work = target.kind === "prototype"
        ? `PROTOTYPE UNDER REVIEW (HTML):\n\`\`\`html\n${(target.output_html ?? "").slice(0, 60000)}\n\`\`\``
        : `RESEARCH UNDER REVIEW:\n${target.output_md ?? ""}\nSOURCES: ${(target.sources ?? []).length}`;
      const r = await geminiJson<any>(
        [{ text: `${userText}\n\n${work}` }], REVIEW_SCHEMA, FAST_MODEL, REVIEW_SYSTEM,
        { thinkingConfig: { thinkingLevel: "low" } },
      );
      // Models sometimes score out of 100; keep it on the 1-10 scale the UI shows.
      r.score = Math.max(1, Math.min(10, Math.round(r.score > 10 ? r.score / 10 : r.score)));
      const md = `**${r.verdict === "pass" ? "Pass" : "Needs revision"}** · ${r.score}/10\n\n` +
        (r.strengths?.length ? `Strengths:\n${r.strengths.map((x: string) => `- ${x}`).join("\n")}\n\n` : "") +
        (r.issues?.length ? `Issues:\n${r.issues.map((x: string) => `- ${x}`).join("\n")}\n\n` : "") +
        (r.verdict === "revise" ? `Revision asked: ${r.revision_instructions}\n\n` : "") +
        (r.question_for_team ? `Question for the team: ${r.question_for_team}` : "");
      await sb.from("jobs").update({ status: "done", review: r, output_md: md, updated_at: now() }).eq("id", jobId);
    } else if (job.kind === "host") {
      const { data: proto } = await sb.from("jobs").select("id, output_html")
        .eq("pipeline_id", job.pipeline_id).eq("kind", "prototype").eq("status", "done")
        .order("id", { ascending: false }).limit(1).maybeSingle();
      if (!proto?.output_html) throw new Error("no prototype to host");
      // Default: a public share page on the Huddle site itself (no new infra, no protection changes).
      // HOST_MODE=vercel deploys each prototype as its own Vercel project instead — note that new
      // Vercel projects may have Deployment Protection on, which you would turn off yourself.
      const site = (Deno.env.get("PUBLIC_SITE_URL") ?? "").replace(/\/$/, "");
      let url: string;
      if (Deno.env.get("HOST_MODE") === "vercel" || !site) {
        const slug = (job.room_id as string).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30);
        url = await deployToVercel(proto.output_html, `huddle-${slug}-p${job.pipeline_id}`);
      } else {
        url = `${site}/p.html?id=${proto.id}`;
      }
      await sb.from("jobs").update({
        status: "done", output_md: `Live at ${url}`, sources: [{ title: "Live prototype", url }], updated_at: now(),
      }).eq("id", jobId);
    } else {
      throw new Error(`unknown job kind ${job.kind}`);
    }

    if (!job.pipeline_id) {
      await sb.from("events").insert({
        room_id: job.room_id, author: "huddle", kind: "system",
        text: `Finished ${job.kind}: ${job.title}`, meta: { job_id: jobId },
      });
    }
  } catch (e) {
    console.error(e);
    await sb.from("jobs").update({ status: "failed", error: String((e as Error)?.message ?? e), updated_at: now() }).eq("id", jobId);
  }
  if (job.pipeline_id) await invokeFn("orchestrate", { pipeline_id: job.pipeline_id });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { job_id } = await req.json();
    if (!job_id) return json({ error: "job_id required" }, 400);
    background(run(Number(job_id)));
    return json({ started: job_id });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
