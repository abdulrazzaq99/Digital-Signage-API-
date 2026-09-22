import { getMailProvider } from "../core/mail/index.js";
import type { MailMessage } from "../core/mail/MailProvider.js";
import { logger } from "../core/middleware/logger.js";

/** Delivers one queued email; BullMQ retries on SMTP failure. */
export async function mailSend(data: MailMessage): Promise<void> {
  await getMailProvider().send(data);
  logger.info({ subject: data.subject, provider: getMailProvider().name }, "mail sent");
}
