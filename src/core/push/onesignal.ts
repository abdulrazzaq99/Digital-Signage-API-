import { logger } from "../middleware/logger.js";
import type { PushAudience, PushMessage, PushProvider, PushSendResult } from "./PushProvider.js";

/** OneSignal REST API v1 notifications endpoint (spec section 12). */
export class OneSignalProvider implements PushProvider {
  readonly name = "onesignal";
  constructor(private readonly appId: string, private readonly apiKey: string) {}

  async send(message: PushMessage, audience: PushAudience): Promise<PushSendResult> {
    if (!audience.externalIds.length) return { providerId: null, recipients: 0 };
    const res = await fetch("https://onesignal.com/api/v1/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${this.apiKey}` },
      body: JSON.stringify({ app_id: this.appId, include_player_ids: audience.externalIds, headings: { en: message.title }, contents: { en: message.body }, ...(message.deepLink ? { url: message.deepLink } : {}), data: message.data ?? {} }),
    });
    if (!res.ok) {
      const text = await res.text();
      logger.error({ status: res.status, text }, "OneSignal send failed");
      throw new Error(`OneSignal responded ${res.status}`);
    }
    const json = (await res.json()) as { id?: string; recipients?: number };
    return { providerId: json.id ?? null, recipients: json.recipients ?? audience.externalIds.length };
  }
}
