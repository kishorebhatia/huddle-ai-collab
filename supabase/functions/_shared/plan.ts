// The planner: decides whether a goal needs research, a build, a backend, and which secrets the room
// must supply. The first stage of every pipeline, and called again when the team's answers change the goal.
import { FAST_MODEL, geminiJson } from "./util.ts";
import { PLAN_SCHEMA, PLAN_SYSTEM } from "./prompts.ts";
import { SECRET_NAME } from "./vault.ts";

export type Input = { name: string; label: string; why: string; get_url?: string };
export type Plan = {
  deliverable: "app" | "research"; needs_research: boolean; needs_backend: boolean;
  required_inputs: Input[]; approach: string; done_when: string;
};

export async function planGoal(goal: string, extra = ""): Promise<Plan> {
  const p = await geminiJson<Plan>([{ text: `GOAL: ${goal}\n${extra}` }], PLAN_SCHEMA, FAST_MODEL, PLAN_SYSTEM);
  const inputs = (Array.isArray(p.required_inputs) ? p.required_inputs : [])
    .map((i) => ({ ...i, name: String(i.name ?? "").toUpperCase().replace(/[^A-Z0-9_]/g, "_") }))
    .filter((i) => SECRET_NAME.test(i.name))
    .slice(0, 5);
  return {
    deliverable: p.deliverable === "app" ? "app" : "research",
    needs_research: !!p.needs_research,
    // A secret can only stay secret on a server.
    needs_backend: !!p.needs_backend || inputs.length > 0,
    required_inputs: inputs,
    approach: String(p.approach ?? ""),
    done_when: String(p.done_when ?? ""),
  };
}

export function planMarkdown(p: Plan) {
  return `**Plan:** ${p.deliverable === "app" ? `build ${p.needs_backend ? "a web app with a backend" : "a web app"}` : "research only"}` +
    `${p.needs_research ? ", researching first" : ""}.\n\n${p.approach}\n\n**Done when:** ${p.done_when}` +
    (p.required_inputs.length ? `\n\n**Needs from the room:** ${p.required_inputs.map((i) => `${i.label} (\`${i.name}\`) ${i.why}`).join("; ")}` : "");
}
