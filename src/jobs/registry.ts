import { UnrecoverableError } from "bullmq";
import { z } from "zod";
import { prisma } from "../core/db/prisma.js";
import { logger, maskEmail } from "../core/middleware/logger.js";
import { JobNames } from "../core/queue/queues.js";
import { companyPurge } from "./company.purge.js";
import { mailSend } from "./mail.send.js";
import { mediaConvert } from "./media.convert.js";
import { notificationSend } from "./notification.send.js";
import { templateRender } from "./template.render.js";

const id = z.string().min(1).max(64);

/** What each job's `data` must look like. A job that doesn't match is failed at once, never retried. */
export const jobData = {
  [JobNames.mediaConvert]: z.object({ assetId: id, companyId: id }),
  [JobNames.templateRender]: z.object({ instanceId: id, companyId: id }),
  [JobNames.notificationSend]: z.object({ notificationId: id }),
  [JobNames.mailSend]: z.object({ to: z.string().min(3).max(320), subject: z.string().max(500), text: z.string(), html: z.string().optional() }),
  [JobNames.companyPurge]: z.object({ companyId: id.regex(/^[A-Za-z0-9_-]+$/) }),
} as const;

type JobName = keyof typeof jobData;

/** The minimal job shape the worker hands us (a BullMQ Job satisfies it). */
export interface JobLike {
  id?: string;
  name: string;
  data: unknown;
  attemptsMade: number;
  opts: { attempts?: number };
}

function parse<N extends JobName>(name: N, data: unknown): z.infer<(typeof jobData)[N]> {
  const result = jobData[name].safeParse(data);
  if (!result.success) throw new UnrecoverableError(`Invalid ${name} job data: ${result.error.issues.map((i) => `${i.path.join(".") || "data"} ${i.message}`).join("; ")}`);
  return result.data as z.infer<(typeof jobData)[N]>;
}

/** Validates the job's data, then runs its processor. Unknown names and bad data are unrecoverable. */
export async function processJob(job: Pick<JobLike, "name" | "data">): Promise<unknown> {
  switch (job.name) {
    case JobNames.mediaConvert:
      return mediaConvert(parse(JobNames.mediaConvert, job.data));
    case JobNames.templateRender:
      return templateRender(parse(JobNames.templateRender, job.data));
    case JobNames.notificationSend:
      return notificationSend(parse(JobNames.notificationSend, job.data));
    case JobNames.mailSend:
      return mailSend(parse(JobNames.mailSend, job.data));
    case JobNames.companyPurge:
      return companyPurge(parse(JobNames.companyPurge, job.data));
    default:
      // Fail it (visible in the failed set) rather than completing a job nothing processed.
      throw new UnrecoverableError(`Unknown job: ${job.name}`);
  }
}

/** BullMQ won't retry it again: out of attempts, or failed with UnrecoverableError. */
export function isFinalFailure(job: Pick<JobLike, "attemptsMade" | "opts">, err: unknown): boolean {
  return err instanceof UnrecoverableError || (err as Error | undefined)?.name === "UnrecoverableError" || job.attemptsMade >= (job.opts.attempts ?? 1);
}

/**
 * Called on every failure; acts only on the final one, so what the job left half-done doesn't stay
 * that way forever. Never throws.
 */
export async function onJobFailed(job: JobLike | undefined, err: unknown): Promise<void> {
  if (!job) return;
  const final = isFinalFailure(job, err);
  logger.error({ err, job: job.name, id: job.id, attempt: job.attemptsMade, final }, final ? "job failed permanently" : "job failed; will retry");
  if (!final) return;
  try {
    switch (job.name) {
      case JobNames.templateRender: {
        const data = jobData[JobNames.templateRender].safeParse(job.data);
        if (!data.success) return;
        // Stop showing "rendering"; the previous output (if any) stays live. The model has no field for
        // the reason, so it is logged above.
        await prisma.templateInstance.updateMany({ where: { id: data.data.instanceId, renderPending: true }, data: { renderPending: false } });
        return;
      }
      case JobNames.mediaConvert: {
        const data = jobData[JobNames.mediaConvert].safeParse(job.data);
        if (!data.success) return;
        await prisma.mediaAsset.updateMany({ where: { id: data.data.assetId, status: "PROCESSING" }, data: { status: "FAILED", failureReason: "Processing failed. Retry, or upload the file again." } });
        return;
      }
      case JobNames.notificationSend: {
        // Notification has no delivery status; it stays unsent (sentAt null), which the admin list shows.
        const data = jobData[JobNames.notificationSend].safeParse(job.data);
        logger.error({ notificationId: data.success ? data.data.notificationId : undefined }, "notification was not delivered");
        return;
      }
      case JobNames.mailSend: {
        const to = typeof (job.data as { to?: unknown })?.to === "string" ? maskEmail((job.data as { to: string }).to) : undefined;
        logger.error({ to, subject: (job.data as { subject?: unknown })?.subject }, "mail was not delivered");
        return;
      }
    }
  } catch (cleanupErr) {
    logger.error({ err: cleanupErr, job: job.name, id: job.id }, "cleanup after failed job failed");
  }
}
