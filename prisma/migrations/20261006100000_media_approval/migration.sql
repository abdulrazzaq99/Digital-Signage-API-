-- Uploads from companies that need approval wait for the Super Admin before screens show them.
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- Files already uploaded stay approved; new uploads choose PENDING or APPROVED in the app.
ALTER TABLE "MediaAsset" ADD COLUMN "approval" "ApprovalStatus" NOT NULL DEFAULT 'APPROVED',
ADD COLUMN "rejectionReason" TEXT,
ADD COLUMN "reviewedAt" TIMESTAMP(3),
ADD COLUMN "reviewedById" TEXT;

ALTER TABLE "Company" ADD COLUMN "mediaApproval" BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX "MediaAsset_approval_createdAt_idx" ON "MediaAsset"("approval", "createdAt");

ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
