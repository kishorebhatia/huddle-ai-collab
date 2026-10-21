// Email for private huddles: sign-in codes, invites, and "someone wants to join".
// Providers, first one configured wins:
//   AgentMail  AGENTMAIL_API_KEY + AGENTMAIL_INBOX_ID
//   Resend     RESEND_API_KEY + EMAIL_FROM
//   MAIL_DEV=1 local testing only: the message is printed to the server log instead of sent.
const env = (k: string) => Deno.env.get(k) ?? "";

export const mailConfigured = () =>
  !!(env("AGENTMAIL_API_KEY") && env("AGENTMAIL_INBOX_ID")) || !!(env("RESEND_API_KEY") && env("EMAIL_FROM")) || env("MAIL_DEV") === "1";

export async function sendMail(to: string, subject: string, text: string, html: string) {
  if (env("AGENTMAIL_API_KEY") && env("AGENTMAIL_INBOX_ID")) {
    const r = await fetch(`https://api.agentmail.to/v0/inboxes/${encodeURIComponent(env("AGENTMAIL_INBOX_ID"))}/messages/send`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env("AGENTMAIL_API_KEY")}` },
      body: JSON.stringify({ to, subject, text, html }),
    });
    if (!r.ok) throw new Error(`email not sent (${r.status})`);
    return;
  }
  if (env("RESEND_API_KEY") && env("EMAIL_FROM")) {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env("RESEND_API_KEY")}` },
      body: JSON.stringify({ from: env("EMAIL_FROM"), to: [to], subject, text, html }),
    });
    if (!r.ok) throw new Error(`email not sent (${r.status})`);
    return;
  }
  if (env("MAIL_DEV") === "1") {
    console.log(`[mail-dev] to=${to} subject=${JSON.stringify(subject)}\n${text}`);
    return;
  }
  throw new Error("email isn't set up on this Huddle");
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** A short, plain message with at most one button. */
export function letter(lines: string[], button?: { label: string; url: string }, footer?: string) {
  const text = [...lines, ...(button ? ["", `${button.label}: ${button.url}`] : []), ...(footer ? ["", footer] : [])].join("\n");
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.5;color:#1E2A22;max-width:480px">` +
    lines.map((l) => `<p style="margin:0 0 12px">${esc(l)}</p>`).join("") +
    (button ? `<p style="margin:20px 0"><a href="${esc(button.url)}" style="background:#244D3C;color:#fff;text-decoration:none;padding:10px 18px;border-radius:10px;font-weight:600;display:inline-block">${esc(button.label)}</a></p>` : "") +
    (footer ? `<p style="margin:20px 0 0;font-size:13px;color:#5C665E">${esc(footer)}</p>` : "") + `</div>`;
  return { text, html };
}
