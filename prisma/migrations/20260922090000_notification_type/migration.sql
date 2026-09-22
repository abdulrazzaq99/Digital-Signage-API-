-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('announcement', 'offer', 'campaign');

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "targetId" TEXT,
ADD COLUMN     "type" "NotificationType" NOT NULL DEFAULT 'announcement';

