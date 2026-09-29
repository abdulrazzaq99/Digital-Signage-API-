import { env } from "../../config/env.js";
import { enqueue, JobNames } from "../queue/queues.js";
import type { MailMessage, MailProvider } from "./MailProvider.js";
import { NoopMailProvider } from "./noop.js";
import { SesMailProvider } from "./ses.js";
import { SmtpMailProvider } from "./smtp.js";

/** SES (role credentials) when SES_REGION is set, else any SMTP relay, else log-only in development. */
let provider: MailProvider = env.SES_REGION
  ? new SesMailProvider(env.SES_REGION, env.MAIL_FROM)
  : env.SMTP_URL
    ? new SmtpMailProvider(env.SMTP_URL, env.MAIL_FROM)
    : new NoopMailProvider();

export function getMailProvider(): MailProvider {
  return provider;
}

/** Test seam. */
export function setMailProvider(p: MailProvider): void {
  provider = p;
}

/**
 * Hands the message to the worker, so SMTP latency or outages never slow or fail the request (and
 * forgot-password timing can't reveal whether an account exists). Completed jobs are dropped at
 * once because the body carries single-use links.
 */
export async function queueMail(message: MailMessage): Promise<void> {
  await enqueue(JobNames.mailSend, { ...message }, { removeOnComplete: true, removeOnFail: 100 });
}
