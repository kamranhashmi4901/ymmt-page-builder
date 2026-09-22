/*
  Warnings:

  - Made the column `fileHash` on table `YmmtUpload` required. This step will fail if there are existing NULL values in that column.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_YmmtUpload" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL,
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
INSERT INTO "new_YmmtUpload" ("createdAt", "fileHash", "fileName", "id", "shop", "sourceProductHandle", "totalMakes", "totalModels", "totalRecords", "totalTrims", "totalYears", "updatedAt", "withTrim", "withoutTrim") SELECT "createdAt", "fileHash", "fileName", "id", "shop", "sourceProductHandle", "totalMakes", "totalModels", "totalRecords", "totalTrims", "totalYears", "updatedAt", "withTrim", "withoutTrim" FROM "YmmtUpload";
DROP TABLE "YmmtUpload";
ALTER TABLE "new_YmmtUpload" RENAME TO "YmmtUpload";
CREATE INDEX "YmmtUpload_shop_idx" ON "YmmtUpload"("shop");
CREATE UNIQUE INDEX "YmmtUpload_shop_fileHash_key" ON "YmmtUpload"("shop", "fileHash");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
