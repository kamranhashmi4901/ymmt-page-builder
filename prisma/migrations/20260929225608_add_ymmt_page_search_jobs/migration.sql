-- CreateTable
CREATE TABLE "YmmtPageSearchJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "fileName" TEXT,
    "totalRecords" INTEGER NOT NULL DEFAULT 0,
    "totalYears" INTEGER NOT NULL DEFAULT 0,
    "processedYears" INTEGER NOT NULL DEFAULT 0,
    "currentYear" TEXT,
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "currentYearTotal" INTEGER NOT NULL DEFAULT 0,
    "currentYearFound" INTEGER NOT NULL DEFAULT 0,
    "currentYearMissing" INTEGER NOT NULL DEFAULT 0,
    "pagesFound" INTEGER NOT NULL DEFAULT 0,
    "missingCount" INTEGER NOT NULL DEFAULT 0,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT,
    "error" TEXT,
    "recordsJson" TEXT NOT NULL,
    "resultPagesJson" TEXT,
    "missingRecordsJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "startedAt" DATETIME,
    "finishedAt" DATETIME
);

-- CreateIndex
CREATE INDEX "YmmtPageSearchJob_shop_createdAt_idx" ON "YmmtPageSearchJob"("shop", "createdAt");
