-- AlterTable
ALTER TABLE "MediaDerivative" ADD COLUMN     "checksum" TEXT,
ADD COLUMN     "mimeType" TEXT,
ADD COLUMN     "sizeBytes" INTEGER;

-- AlterTable
ALTER TABLE "PlaylistItem" ADD COLUMN     "page" INTEGER;

-- AlterTable
ALTER TABLE "TemplateInstance" ADD COLUMN     "renderPending" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "valuesVersion" INTEGER NOT NULL DEFAULT 0;

