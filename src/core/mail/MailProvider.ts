/** Mail delivery abstraction, like PushProvider: the API never talks to a vendor directly. */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface MailProvider {
  readonly name: string;
  send(message: MailMessage): Promise<void>;
}
