-- Locations get a category (Kiosk, Restaurant, ...) and Head Office content says who sees it.
-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "categoryId" TEXT;

-- AlterTable
ALTER TABLE "Offer" ADD COLUMN     "audience" JSONB NOT NULL DEFAULT '{"kind":"all"}';

-- AlterTable
ALTER TABLE "ScratchCampaign" ADD COLUMN     "audience" JSONB NOT NULL DEFAULT '{"kind":"all"}';

-- AlterTable
ALTER TABLE "Template" ADD COLUMN     "audience" JSONB NOT NULL DEFAULT '{"kind":"all"}';

-- CreateTable
CREATE TABLE "LocationCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LocationCategory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LocationCategory_name_key" ON "LocationCategory"("name");

-- CreateIndex
CREATE INDEX "Company_categoryId_idx" ON "Company"("categoryId");

-- AddForeignKey
ALTER TABLE "Company" ADD CONSTRAINT "Company_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "LocationCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- The two categories the client starts with; more can be added in Settings.
INSERT INTO "LocationCategory" ("id", "name", "createdAt", "updatedAt") VALUES
  ('ckioskcategory000000000001', 'Kiosk', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('crestaurantcategory0000001', 'Restaurant', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
