import { isProd } from "../../config/env.js";
import { logger } from "../middleware/logger.js";
import type { MailMessage, MailProvider } from "./MailProvider.js";

/** Used when SMTP_URL is absent (tests, local without Mailpit). Records calls so tests can assert on them. */
export class NoopMailProvider implements MailProvider {
  readonly name = "noop";
  readonly sent: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
    // Outside production the body is logged so reset and invite links can be followed by hand.
    if (isProd) logger.warn({ subject: message.subject }, "mail dropped: SMTP_URL is not configured");
    else logger.info({ to: message.to, subject: message.subject, text: message.text }, "mail (noop)");
  }
}
