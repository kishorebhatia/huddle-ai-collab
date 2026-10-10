// POST { job_id } -> runs a research or prototype job in the background; status streams back via Realtime
import { background, cors, db, gemini, json, SMART_MODEL } from "../_shared/util.ts";

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
actually work. Keep it focused: one screen, under ~400 lines total, so it builds in well under a minute. Return ONLY the HTML document inside one \`\`\`html code block, then one line starting
with "SUMMARY:" describing what it does and how to try it.`;

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

async function run(jobId: number) {
  const sb = db();
  const { data: job } = await sb.from("jobs").select("*").eq("id", jobId).single();
  if (!job) return;
  await sb.from("jobs").update({ status: "running", error: null, updated_at: new Date().toISOString() }).eq("id", jobId);

  try {
    const { data: brain } = await sb.from("brain").select("state").eq("room_id", job.room_id).maybeSingle();
    const s = brain?.state ?? {};
    const context =
      `TEAM GOAL: ${s.goal ?? "(not set)"}\nWHERE THINGS STAND: ${s.summary ?? ""}\n` +
      `DECISIONS: ${(s.decisions ?? []).map((d: any) => d.text).join("; ")}`;

    let parentBlock = "";
    if (job.parent_id) {
      const { data: parent } = await sb.from("jobs").select("*").eq("id", job.parent_id).single();
      if (parent) {
        parentBlock = job.kind === "prototype"
          ? `\n\nPREVIOUS VERSION (revise it, keep what works):\n\`\`\`html\n${parent.output_html ?? ""}\n\`\`\``
          : `\n\nPREVIOUS BRIEF (revise and extend it):\n${parent.output_md ?? ""}`;
        parentBlock += `\n\nORIGINAL TASK: ${parent.prompt}`;
      }
    }

    const userText = `${context}\n\nTASK: ${job.title}\n${job.prompt}${parentBlock}`;

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
      await sb.from("jobs").update({
        status: "done", output_md: text + note, sources, updated_at: new Date().toISOString(),
      }).eq("id", jobId);
    } else {
      const { text } = await gemini({
        systemInstruction: { parts: [{ text: PROTOTYPE_SYSTEM }] },
        contents: [{ role: "user", parts: [{ text: userText }] }],
        // "low" keeps big prototypes well inside the Edge Function wall-clock limit (150 s on free).
        generationConfig: { thinkingConfig: { thinkingLevel: Deno.env.get("PROTOTYPE_THINKING") ?? "low" } },
      }, SMART_MODEL);
      const html = extractHtml(text);
      if (!html) throw new Error("model returned no HTML");
      const summary = text.match(/SUMMARY:\s*(.+)/i)?.[1]?.trim() ?? "";
      await sb.from("jobs").update({
        status: "done", output_html: html, output_md: summary, updated_at: new Date().toISOString(),
      }).eq("id", jobId);
    }

    await sb.from("events").insert({
      room_id: job.room_id, author: "huddle", kind: "system",
      text: `Finished ${job.kind}: ${job.title}`, meta: { job_id: jobId },
    });
  } catch (e) {
    console.error(e);
    await sb.from("jobs").update({ status: "failed", error: String(e?.message ?? e) }).eq("id", jobId);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { job_id } = await req.json();
    if (!job_id) return json({ error: "job_id required" }, 400);
    background(run(Number(job_id)));
    return json({ started: job_id });
  } catch (e) {
    return json({ error: String(e?.message ?? e) }, 500);
  }
});
