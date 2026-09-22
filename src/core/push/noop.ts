import { logger } from "../middleware/logger.js";
import type { PushAudience, PushMessage, PushProvider, PushSendResult } from "./PushProvider.js";

/** Used when OneSignal keys are absent (local, tests). Records calls so tests can assert on them. */
export class NoopPushProvider implements PushProvider {
  readonly name = "noop";
  readonly sent: { message: PushMessage; audience: PushAudience }[] = [];

  async send(message: PushMessage, audience: PushAudience): Promise<PushSendResult> {
    this.sent.push({ message, audience });
    logger.info({ title: message.title, recipients: audience.externalIds.length }, "push (noop)");
    return { providerId: `noop-${this.sent.length}`, recipients: audience.externalIds.length, invalidIds: [] };
  }
}
