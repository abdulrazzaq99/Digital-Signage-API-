import { Queue, type JobsOptions } from "bullmq";
import { createRedisConnection } from "../redis/client.js";

export const JobNames = {
  mediaConvert: "media.convert",
  templateRender: "template.render",
  notificationSend: "notification.send",
  mailSend: "mail.send",
  companyPurge: "company.purge",
  presenceSweep: "presence.sweep",
} as const;

export const QUEUE_NAME = "dsp";

let queue: Queue | null = null;

/** Single queue with named jobs; the worker registers a processor per job name. */
export function getQueue(): Queue {
  if (!queue) queue = new Queue(QUEUE_NAME, { connection: createRedisConnection(), defaultJobOptions: { attempts: 3, backoff: { type: "exponential", delay: 2000 }, removeOnComplete: 500, removeOnFail: 1000 } });
  return queue;
}

export async function enqueue(name: (typeof JobNames)[keyof typeof JobNames], data: Record<string, unknown>, opts?: JobsOptions): Promise<void> {
  await getQueue().add(name, data, opts);
}

export async function closeQueue(): Promise<void> {
  await queue?.close();
  queue = null;
}
