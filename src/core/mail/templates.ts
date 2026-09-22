import { env } from "../../config/env.js";
import type { MailMessage } from "./MailProvider.js";

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

/**
 * The link the web app serves and the mobile apps intercept (Universal Links / App Links):
 * `${APP_PUBLIC_URL}/reset-password?token=…`. Invites use the same page to set a first password.
 */
export const passwordLink = (token: string) => `${env.APP_PUBLIC_URL.replace(/\/$/, "")}/reset-password?token=${encodeURIComponent(token)}`;

function layout(lines: string[], cta: { label: string; href: string }, footer: string): string {
  const body = lines.map((l) => `<p style="margin:0 0 16px">${escape(l)}</p>`).join("");
  return `<!doctype html><html><body style="margin:0;background:#f8fafc;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a">
<div style="max-width:520px;margin:0 auto;padding:32px 24px"><div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:28px;font-size:14px;line-height:1.55">
${body}<p style="margin:24px 0"><a href="${escape(cta.href)}" style="background:#4f46e5;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;display:inline-block">${escape(cta.label)}</a></p>
<p style="margin:0;color:#64748b;font-size:12px">${escape(footer)}</p></div></div></body></html>`;
}

export function passwordResetEmail(to: { email: string; name: string }, token: string): MailMessage {
  const link = passwordLink(token);
  const lines = [`Hi ${to.name},`, "We received a request to reset the password for your Digital Signage account. The link below is valid for one hour and can be used once."];
  const footer = "If you didn't ask for this, you can ignore this email; your password won't change.";
  return { to: to.email, subject: "Reset your Digital Signage password", text: `${lines.join("\n\n")}\n\n${link}\n\n${footer}`, html: layout(lines, { label: "Reset password", href: link }, footer) };
}

export function inviteEmail(to: { email: string; name: string }, companyName: string, invitedBy: string, token: string): MailMessage {
  const link = passwordLink(token);
  const lines = [`Hi ${to.name},`, `${invitedBy} has invited you to ${companyName} on Digital Signage. Set a password to activate your account. The link is valid for 7 days.`];
  const footer = "If you weren't expecting this invitation, you can ignore this email.";
  return { to: to.email, subject: `You've been invited to ${companyName} on Digital Signage`, text: `${lines.join("\n\n")}\n\n${link}\n\n${footer}`, html: layout(lines, { label: "Set your password", href: link }, footer) };
}
