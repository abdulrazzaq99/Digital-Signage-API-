import type { MailMessage } from "../core/mail/MailProvider.js";
import { getQueue, JobNames } from "../core/queue/queues.js";

/** Mail the API queued for `to`, oldest first. No worker runs in tests, so jobs stay in the queue. */
export async function queuedMail(to: string): Promise<MailMessage[]> {
  const jobs = await getQueue().getJobs(["waiting", "delayed", "prioritized"]);
  return jobs.filter((j) => j.name === JobNames.mailSend && j.data.to === to).sort((a, b) => a.timestamp - b.timestamp).map((j) => j.data as MailMessage);
}

/** The token from the reset/set-password link in a queued email. */
export function linkToken(mail: MailMessage | undefined): string {
  const match = mail?.text.match(/\/reset-password\?token=([^\s]+)/);
  if (!match?.[1]) throw new Error("no password link in mail");
  return decodeURIComponent(match[1]);
}
