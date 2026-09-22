import { createHash } from "node:crypto";
import { logger } from "../middleware/logger.js";
import type { PushAudience, PushMessage, PushProvider, PushSendResult } from "./PushProvider.js";

const ENDPOINT = "https://api.onesignal.com/notifications?c=push";
/** OneSignal accepts at most 20,000 subscription IDs per request. */
const MAX_IDS_PER_REQUEST = 20_000;

/** OneSignal's idempotency_key must be a UUID; derive a stable one from our key. */
function idempotencyUuid(key: string): string {
  const h = createHash("sha256").update(key).digest("hex");
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * OneSignal REST API (spec section 12): `POST /notifications` with an App API key (`Key` auth),
 * targeting subscription IDs (`OneSignal.User.pushSubscription.id` on the device).
 */
export class OneSignalProvider implements PushProvider {
  readonly name = "onesignal";
  constructor(private readonly appId: string, private readonly apiKey: string, private readonly batchSize = MAX_IDS_PER_REQUEST) {}

  async send(message: PushMessage, audience: PushAudience): Promise<PushSendResult> {
    let providerId: string | null = null;
    let recipients = 0;
    const invalidIds: string[] = [];
    for (let i = 0; i < audience.externalIds.length; i += this.batchSize) {
      const ids = audience.externalIds.slice(i, i + this.batchSize);
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Key ${this.apiKey}` },
        body: JSON.stringify({
          app_id: this.appId,
          target_channel: "push",
          include_subscription_ids: ids,
          headings: { en: message.title },
          contents: { en: message.body },
          data: message.data ?? {},
          ...(message.appUrl ? { app_url: message.appUrl } : {}),
          ...(message.webUrl ? { web_url: message.webUrl } : {}),
          ...(message.idempotencyKey ? { idempotency_key: idempotencyUuid(`${message.idempotencyKey}:${i}`) } : {}),
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        logger.error({ status: res.status, text }, "OneSignal send failed");
        throw new Error(`OneSignal responded ${res.status}`);
      }
      // `errors` is `{ invalid_player_ids: [...] }` for dead subscriptions, or a list of messages
      // such as "All included players are not subscribed".
      const json = (await res.json()) as { id?: string; errors?: string[] | { invalid_player_ids?: string[] } };
      const invalid = Array.isArray(json.errors) ? [] : (json.errors?.invalid_player_ids ?? []).filter((id) => ids.includes(id));
      if (Array.isArray(json.errors)) logger.warn({ errors: json.errors }, "OneSignal accepted the request with errors");
      invalidIds.push(...invalid);
      recipients += ids.length - invalid.length;
      providerId ??= json.id || null;
    }
    return { providerId, recipients, invalidIds };
  }
}
