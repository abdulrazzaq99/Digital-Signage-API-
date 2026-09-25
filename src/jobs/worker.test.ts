import { UnrecoverableError } from "bullmq";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../core/db/prisma.js";
import { JobNames } from "../core/queue/queues.js";
import { redis } from "../core/redis/client.js";
import { createCompany } from "../test/factories.js";
import { closeAll, resetDatabase } from "../test/helpers.js";
import { isFinalFailure, onJobFailed, processJob } from "./registry.js";
import { createSweep, sweepLockKey } from "./sweep.js";

beforeEach(resetDatabase);
afterAll(closeAll);

const job = (name: string, data: unknown, attemptsMade = 3, attempts = 3) => ({ id: "1", name, data, attemptsMade, opts: { attempts } });

describe("job validation", () => {
  it("fails jobs with bad data or an unknown name without retrying", async () => {
    await expect(processJob({ name: JobNames.mediaConvert, data: { assetId: 42 } })).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(processJob({ name: JobNames.companyPurge, data: { companyId: "../../etc" } })).rejects.toThrow(/Invalid company.purge job data/);
    await expect(processJob({ name: "nope", data: {} })).rejects.toBeInstanceOf(UnrecoverableError);
    // A valid job for a record that no longer exists is a no-op.
    await expect(processJob({ name: JobNames.notificationSend, data: { notificationId: "gone" } })).resolves.toBeUndefined();
  });

  it("knows when a failure is final", () => {
    expect(isFinalFailure({ attemptsMade: 1, opts: { attempts: 3 } }, new Error("x"))).toBe(false);
    expect(isFinalFailure({ attemptsMade: 3, opts: { attempts: 3 } }, new Error("x"))).toBe(true);
    expect(isFinalFailure({ attemptsMade: 1, opts: { attempts: 3 } }, new UnrecoverableError("x"))).toBe(true);
  });
});

describe("final failure cleanup", () => {
  it("clears a template's rendering flag only once retries are exhausted", async () => {
    const company = await createCompany();
    const template = await prisma.template.create({ data: { name: "Promo", category: "Retail", fields: [] } });
    const instance = await prisma.templateInstance.create({ data: { companyId: company.id, templateId: template.id, name: "Spring", values: {}, renderPending: true } });
    await onJobFailed(job(JobNames.templateRender, { instanceId: instance.id, companyId: company.id }, 1), new Error("sharp crashed"));
    expect((await prisma.templateInstance.findUniqueOrThrow({ where: { id: instance.id } })).renderPending).toBe(true);
    await onJobFailed(job(JobNames.templateRender, { instanceId: instance.id, companyId: company.id }), new Error("sharp crashed"));
    expect((await prisma.templateInstance.findUniqueOrThrow({ where: { id: instance.id } })).renderPending).toBe(false);
  });

  it("marks media still processing as failed", async () => {
    const company = await createCompany();
    const asset = await prisma.mediaAsset.create({ data: { companyId: company.id, name: "a.mp4", type: "VIDEO", status: "PROCESSING", mimeType: "video/mp4", storageKey: `${company.id}/a.mp4` } });
    await onJobFailed(job(JobNames.mediaConvert, { assetId: asset.id, companyId: company.id }), new Error("s3 down"));
    expect(await prisma.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } })).toMatchObject({ status: "FAILED", failureReason: expect.any(String) });
    // Bad data and unknown jobs never throw from the handler.
    await expect(onJobFailed(job(JobNames.mailSend, { to: "someone@example.com", subject: "Hi" }), new Error("smtp"))).resolves.toBeUndefined();
    await expect(onJobFailed(job("nope", null), new Error("x"))).resolves.toBeUndefined();
  });
});

describe("sweeps", () => {
  it("skips a tick while the previous run is still going", async () => {
    let release!: () => void;
    let runs = 0;
    const sweep = createSweep("test-overlap", () => { runs++; return new Promise<void>((r) => (release = r)); }, 60_000);
    const first = sweep.tick();
    await new Promise((r) => setTimeout(r, 50));
    expect(await sweep.tick()).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(runs).toBe(1);
  });

  it("runs at most once per interval across workers", async () => {
    let runs = 0;
    const a = createSweep("test-lock", async () => { runs++; }, 60_000);
    const b = createSweep("test-lock", async () => { runs++; }, 60_000);
    expect(await a.tick()).toBe(true);
    expect(await b.tick()).toBe(false);
    expect(runs).toBe(1);
    await redis.del(sweepLockKey("test-lock"));
    expect(await b.tick()).toBe(true);
    expect(runs).toBe(2);
  });

  it("logs a failing run instead of throwing", async () => {
    const sweep = createSweep("test-error", async () => { throw new Error("boom"); }, 60_000);
    expect(await sweep.tick()).toBe(false);
  });
});
