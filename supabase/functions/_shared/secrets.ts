// Keeps keys out of room repositories. Two passes before anything is pushed:
//   1. known key patterns, redacted here (instant)
//   2. gitleaks over the exact files, inside a Daytona sandbox; anything it finds is redacted too
import { daytonaOn, deploySandbox, exec, upload, type Sandbox } from "./daytona.ts";
import { span } from "./trace.ts";

const PATTERNS: [string, RegExp][] = [
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["aws-session-token", /\bIQoJb3JpZ2lu[A-Za-z0-9/+=]{40,}/g],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g],
  ["api-key-sk", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g],
  ["stripe-key", /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/g],
  ["slack-token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["daytona-key", /\bdtn_[a-f0-9]{32,}\b/g],
  ["arize-key", /\bak-[a-f0-9]{8}-[a-f0-9-]{20,}[A-Za-z0-9_-]*/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  // key = "value" style assignments with a long value
  ["assigned-secret", /((?:api[_-]?key|secret|token|password|passwd|client[_-]?secret|access[_-]?key)["']?\s*[:=]\s*["'])([^"'\s]{12,})(["'])/gi],
];

export type Finding = { file: string; rule: string; source: "pattern" | "gitleaks" };

/** Redact known key patterns. Returns the cleaned files and what was found. */
export function redactPatterns(files: Record<string, string>) {
  const out: Record<string, string> = {};
  const findings: Finding[] = [];
  for (const [file, text] of Object.entries(files)) {
    let t = text;
    for (const [rule, re] of PATTERNS) {
      t = t.replace(re, (...m) => {
        findings.push({ file, rule, source: "pattern" });
        return rule === "assigned-secret" ? `${m[1]}[REDACTED]${m[3]}` : `[REDACTED:${rule}]`;
      });
    }
    out[file] = t;
  }
  return { files: out, findings };
}

// One scanner sandbox per server process, reused across publishes.
// deno-lint-ignore no-explicit-any
const G = globalThis as any;

async function scanner(): Promise<Sandbox> {
  if (G.__huddleScanner) return G.__huddleScanner;
  const sb = await deploySandbox({ app: "huddle", role: "secret-scan" });
  const arch = (await exec(sb, "uname -m", 20)).result.includes("aarch64") ? "arm64" : "x64";
  const v = "8.21.2";
  const r = await exec(sb, `bash -lc "mkdir -p /home/daytona/bin && curl -sSL https://github.com/gitleaks/gitleaks/releases/download/v${v}/gitleaks_${v}_linux_${arch}.tar.gz | tar xz -C /home/daytona/bin gitleaks && /home/daytona/bin/gitleaks version"`, 90);
  if (r.exitCode !== 0) throw new Error(`gitleaks install failed: ${r.result.slice(0, 200)}`);
  G.__huddleScanner = sb;
  return sb;
}

/** Run gitleaks over the files in a Daytona sandbox and redact whatever it finds. */
export async function gitleaks(files: Record<string, string>): Promise<{ files: Record<string, string>; findings: Finding[]; ran: boolean; note: string }> {
  if (!daytonaOn()) return { files, findings: [], ran: false, note: "gitleaks skipped (no Daytona key)" };
  return await span("daytona.gitleaks", "TOOL", { "tool.name": "gitleaks", "input.value": Object.keys(files).join("\n") }, async (s) => {
    let sb: Sandbox;
    try {
      sb = await scanner();
    } catch (e) {
      G.__huddleScanner = null;
      return { files, findings: [], ran: false, note: `gitleaks unavailable: ${String(e).slice(0, 160)}` };
    }
    const dir = `scan-${Date.now()}`;
    try {
      for (const [path, text] of Object.entries(files)) await upload(sb, `${dir}/${path}`, text, "/home/daytona");
      const r = await exec(sb, `bash -lc "/home/daytona/bin/gitleaks dir /home/daytona/${dir} --no-banner --exit-code 0 --report-format json --report-path /tmp/${dir}.json >/dev/null 2>&1; cat /tmp/${dir}.json; rm -rf /home/daytona/${dir} /tmp/${dir}.json"`, 90);
      // deno-lint-ignore no-explicit-any
      const found: any[] = JSON.parse(r.result.trim() || "[]");
      const out = { ...files };
      const findings: Finding[] = [];
      for (const f of found) {
        const file = String(f.File ?? "").replace(`/home/daytona/${dir}/`, "");
        if (!(file in out) || !f.Secret) continue;
        out[file] = out[file].split(f.Secret).join(`[REDACTED:${f.RuleID ?? "secret"}]`);
        findings.push({ file, rule: String(f.RuleID ?? "secret"), source: "gitleaks" });
      }
      s.set({ "output.value": JSON.stringify(findings) });
      return { files: out, findings, ran: true, note: `gitleaks ${found.length ? `found ${found.length}` : "found nothing"}` };
    } catch (e) {
      G.__huddleScanner = null; // recreate next time
      return { files, findings: [], ran: false, note: `gitleaks failed: ${String(e).slice(0, 160)}` };
    }
  });
}
