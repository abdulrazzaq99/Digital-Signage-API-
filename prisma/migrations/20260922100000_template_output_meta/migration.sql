-- AlterTable
ALTER TABLE "TemplateInstance" ADD COLUMN     "outputChecksum" TEXT,
ADD COLUMN     "outputHeight" INTEGER,
ADD COLUMN     "outputMimeType" TEXT,
ADD COLUMN     "outputSizeBytes" INTEGER,
ADD COLUMN     "outputWidth" INTEGER;

