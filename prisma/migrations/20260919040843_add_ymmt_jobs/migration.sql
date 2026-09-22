-- CreateTable
CREATE TABLE "YmmtJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "uploadId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'create',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "total" INTEGER NOT NULL DEFAULT 0,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "YmmtJobLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'info',
    "message" TEXT NOT NULL,
    "handle" TEXT,
    "recordId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "YmmtJobLog_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "YmmtJob" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "YmmtJob_shop_idx" ON "YmmtJob"("shop");

-- CreateIndex
CREATE INDEX "YmmtJob_uploadId_idx" ON "YmmtJob"("uploadId");

-- CreateIndex
CREATE INDEX "YmmtJob_status_idx" ON "YmmtJob"("status");

-- CreateIndex
CREATE INDEX "YmmtJobLog_jobId_idx" ON "YmmtJobLog"("jobId");
