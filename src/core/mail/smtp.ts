import nodemailer, { type Transporter } from "nodemailer";
import type { MailMessage, MailProvider } from "./MailProvider.js";

/** Any SMTP relay (SES, Postmark, SendGrid, Mailpit in dev) configured by a single SMTP_URL. */
export class SmtpMailProvider implements MailProvider {
  readonly name = "smtp";
  private readonly transport: Transporter;

  constructor(url: string, private readonly from: string) {
    this.transport = nodemailer.createTransport(url);
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.from, to: message.to, subject: message.subject, text: message.text, html: message.html });
  }
}
