/** Push delivery abstraction. The API never talks to a vendor directly. */
export interface PushMessage {
  title: string;
  body: string;
  deepLink?: string;
  data?: Record<string, string>;
}

export interface PushAudience {
  /** Vendor player/subscription IDs to target. */
  externalIds: string[];
}

export interface PushSendResult {
  providerId: string | null;
  recipients: number;
}

export interface PushProvider {
  readonly name: string;
  send(message: PushMessage, audience: PushAudience): Promise<PushSendResult>;
}
