// The door for each teammate's own Claude/Gemini/agent.
//   GET  ?room=ID            -> the living brief as markdown (paste into or fetch from any assistant)
//   POST { room, author, text, url?, kind? }  -> posts a finding/note into the room
import { background, cors, db, json } from "../_shared/util.ts";
import { invokeFn } from "../_shared/pipeline.ts";
import { redactPatterns } from "../_shared/secrets.ts";

function toMarkdown(room: string, s: any, jobs: any[]) {
  const list = (title: string, items: any[] = [], fmt = (i: any) => i.text) =>
    items.length ? `\n## ${title}\n${items.map((i) => `- ${fmt(i)}`).join("\n")}\n` : "";
  return [
    `# Huddle brief — room ${room}`,
    s.goal ? `\n**Goal:** ${s.goal}` : "",
    s.summary ? `\n${s.summary}` : "",
    list("Decisions", s.decisions),
    list("Open questions", s.questions),
    list("Ideas", s.ideas),
    list("Next steps", s.next_steps, (i) => `[${i.type ?? "todo"}] ${i.text}${i.owner ? ` — ${i.owner}` : ""}`),
    list("Agent jobs", jobs, (j) => `#${j.id} ${j.kind} (${j.status}): ${j.title}`),
    `\n---\nPost findings back: POST this URL with JSON {"room":"${room}","author":"<you>","text":"<finding>"}`,
  ].join("\n");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const sb = db();
  try {
    if (req.method === "GET") {
      const room = new URL(req.url).searchParams.get("room");
      if (!room) return json({ error: "room required" }, 400);
      const { data: brain } = await sb.from("brain").select("state").eq("room_id", room).maybeSingle();
      const { data: jobs } = await sb.from("jobs").select("id, kind, title, status")
        .eq("room_id", room).neq("status", "dismissed").order("id");
      return new Response(toMarkdown(room, brain?.state ?? {}, jobs ?? []), {
        headers: { ...cors, "content-type": "text/markdown; charset=utf-8" },
      });
    }
    const { room, author, text: raw, url, kind } = await req.json();
    if (!room || !raw) return json({ error: "room and text required" }, 400);
    // Keys an assistant pastes are redacted before they're stored, same as from the browser.
    const text = redactPatterns({ t: String(raw) }).files.t;
    const { data, error } = await sb.from("events").insert({
      room_id: room,
      author: author ?? "an assistant",
      kind: ["finding", "note", "link", "feedback"].includes(kind) ? kind : "finding",
      text: url ? `${text}\n${url}` : text,
    }).select().single();
    if (error) throw error;
    // A request from someone's own AI ("Huddle, build …") starts work like a spoken one does.
    background(invokeFn("intake", { room, author: data.author, text, event_id: data.id }));
    return json({ ok: true, event_id: data.id });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
