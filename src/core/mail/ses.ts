import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import type { MailMessage, MailProvider } from "./MailProvider.js";

/**
 * Amazon SES via the API, not SMTP: credentials come from the SDK's default chain (the EC2
 * instance role in production), so no mail password is stored anywhere.
 */
export class SesMailProvider implements MailProvider {
  readonly name = "ses";
  private readonly client: SESv2Client;

  constructor(region: string, private readonly from: string) {
    this.client = new SESv2Client({ region });
  }

  async send(message: MailMessage): Promise<void> {
    await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: this.from,
        Destination: { ToAddresses: [message.to] },
        Content: {
          Simple: {
            Subject: { Data: message.subject, Charset: "UTF-8" },
            Body: {
              Text: { Data: message.text, Charset: "UTF-8" },
              ...(message.html ? { Html: { Data: message.html, Charset: "UTF-8" } } : {}),
            },
          },
        },
      }),
    );
  }
}
