import { env } from "../../config/env.js";
import { NoopPushProvider } from "./noop.js";
import { OneSignalProvider } from "./onesignal.js";
import type { PushProvider } from "./PushProvider.js";

export const noopPush = new NoopPushProvider();

let provider: PushProvider = env.ONESIGNAL_APP_ID && env.ONESIGNAL_API_KEY ? new OneSignalProvider(env.ONESIGNAL_APP_ID, env.ONESIGNAL_API_KEY) : noopPush;

export function getPushProvider(): PushProvider {
  return provider;
}

/** Test seam. */
export function setPushProvider(p: PushProvider): void {
  provider = p;
}
