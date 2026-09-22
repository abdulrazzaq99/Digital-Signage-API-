/** Push delivery abstraction. The API never talks to a vendor directly. */
export interface PushMessage {
  title: string;
  body: string;
  /** Handed to the app with the notification: `{ notificationId, type, targetId? }` (the R1 contract). */
  data?: Record<string, string>;
  /** Deep link opened on phones, e.g. `dsp://offers/<id>`. */
  appUrl?: string;
  /** HTTPS page opened by web push. Never used on phones, where it would open a browser. */
  webUrl?: string;
  /** Stable for one logical send, so a retried job is not delivered twice. */
  idempotencyKey?: string;
}

export interface PushAudience {
  /** Vendor subscription IDs to target. */
  externalIds: string[];
}

export interface PushSendResult {
  providerId: string | null;
  recipients: number;
  /** Subscription IDs the vendor no longer recognises; the caller drops them. */
  invalidIds: string[];
}

export interface PushProvider {
  readonly name: string;
  send(message: PushMessage, audience: PushAudience): Promise<PushSendResult>;
}
