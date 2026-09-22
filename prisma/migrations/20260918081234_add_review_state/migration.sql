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
    "selected" BOOLEAN NOT NULL DEFAULT false,
    "duplicate" BOOLEAN NOT NULL DEFAULT false,
    "proposedHandle" TEXT,
    CONSTRAINT "YmmtRecord_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "YmmtUpload" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_YmmtRecord" ("compatible", "id", "make", "manufacturer", "model", "trim", "uploadId", "warning", "year") SELECT "compatible", "id", "make", "manufacturer", "model", "trim", "uploadId", "warning", "year" FROM "YmmtRecord";
DROP TABLE "YmmtRecord";
ALTER TABLE "new_YmmtRecord" RENAME TO "YmmtRecord";
CREATE INDEX "YmmtRecord_uploadId_idx" ON "YmmtRecord"("uploadId");
CREATE INDEX "YmmtRecord_year_make_model_idx" ON "YmmtRecord"("year", "make", "model");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
