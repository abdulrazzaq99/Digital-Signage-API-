import { execSync } from "node:child_process";
import { CreateBucketCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { config } from "dotenv";
import { testEnvFile } from "./envFile.js";

/** Runs once before the test suite: load the test env file and apply migrations to the test database. */
export default async function globalSetup(): Promise<void> {
  config({ path: testEnvFile, override: true });
  execSync("npx prisma migrate deploy", { stdio: "inherit", env: { ...process.env } });
  await ensureBucket();
}

/** Creates the test bucket in MinIO if it does not exist (no dependency on the mc CLI). */
async function ensureBucket(): Promise<void> {
  const s3 = new S3Client({ region: process.env.S3_REGION ?? "us-east-1", endpoint: process.env.S3_ENDPOINT, forcePathStyle: true, credentials: { accessKeyId: process.env.S3_ACCESS_KEY ?? "", secretAccessKey: process.env.S3_SECRET_KEY ?? "" } });
  const Bucket = process.env.S3_BUCKET ?? "media-test";
  try {
    await s3.send(new HeadBucketCommand({ Bucket }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket }));
  }
}
