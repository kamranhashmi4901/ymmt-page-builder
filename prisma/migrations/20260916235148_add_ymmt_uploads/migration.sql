/*
  Warnings:

  - You are about to drop the column `position` on the `YmmtRecord` table. All the data in the column will be lost.
  - You are about to drop the column `shop` on the `YmmtRecord` table. All the data in the column will be lost.
  - You are about to drop the column `sourceProductId` on the `YmmtUpload` table. All the data in the column will be lost.
  - You are about to drop the column `sourceProductTitle` on the `YmmtUpload` table. All the data in the column will be lost.
  - You are about to drop the column `stats` on the `YmmtUpload` table. All the data in the column will be lost.
  - Added the required column `totalMakes` to the `YmmtUpload` table without a default value. This is not possible if the table is not empty.
  - Added the required column `totalModels` to the `YmmtUpload` table without a default value. This is not possible if the table is not empty.
  - Added the required column `totalRecords` to the `YmmtUpload` table without a default value. This is not possible if the table is not empty.
  - Added the required column `totalTrims` to the `YmmtUpload` table without a default value. This is not possible if the table is not empty.
  - Added the required column `totalYears` to the `YmmtUpload` table without a default value. This is not possible if the table is not empty.
  - Added the required column `withTrim` to the `YmmtUpload` table without a default value. This is not possible if the table is not empty.
  - Added the required column `withoutTrim` to the `YmmtUpload` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_YmmtRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "uploadId" TEXT NOT NULL,
    "year" TEXT NOT NULL,
    "make" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "trim" TEXT,
    "warning" TEXT,
    "compatible" TEXT,
    "manufacturer" TEXT,
    CONSTRAINT "YmmtRecord_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "YmmtUpload" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_YmmtRecord" ("compatible", "id", "make", "manufacturer", "model", "trim", "uploadId", "warning", "year") SELECT "compatible", "id", "make", "manufacturer", "model", "trim", "uploadId", "warning", "year" FROM "YmmtRecord";
DROP TABLE "YmmtRecord";
ALTER TABLE "new_YmmtRecord" RENAME TO "YmmtRecord";
CREATE INDEX "YmmtRecord_uploadId_idx" ON "YmmtRecord"("uploadId");
CREATE INDEX "YmmtRecord_year_make_model_idx" ON "YmmtRecord"("year", "make", "model");
CREATE TABLE "new_YmmtUpload" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "totalRecords" INTEGER NOT NULL,
    "totalYears" INTEGER NOT NULL,
    "totalMakes" INTEGER NOT NULL,
    "totalModels" INTEGER NOT NULL,
    "totalTrims" INTEGER NOT NULL,
    "withTrim" INTEGER NOT NULL,
    "withoutTrim" INTEGER NOT NULL,
    "sourceProductHandle" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_YmmtUpload" ("createdAt", "fileName", "id", "shop", "sourceProductHandle", "updatedAt") SELECT "createdAt", "fileName", "id", "shop", "sourceProductHandle", "updatedAt" FROM "YmmtUpload";
DROP TABLE "YmmtUpload";
ALTER TABLE "new_YmmtUpload" RENAME TO "YmmtUpload";
CREATE INDEX "YmmtUpload_shop_idx" ON "YmmtUpload"("shop");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
