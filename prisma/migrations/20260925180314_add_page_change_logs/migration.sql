-- CreateTable
CREATE TABLE "PageActionSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "totalPages" INTEGER NOT NULL DEFAULT 0,
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "filterSnapshot" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "rolledBackAt" DATETIME
);

-- CreateTable
CREATE TABLE "PageChangeLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "shopifyPageId" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "beforeData" TEXT,
    "afterData" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rolledBackAt" DATETIME,
    CONSTRAINT "PageChangeLog_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "PageActionSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "PageActionSession_shop_idx" ON "PageActionSession"("shop");

-- CreateIndex
CREATE INDEX "PageActionSession_createdAt_idx" ON "PageActionSession"("createdAt");

-- CreateIndex
CREATE INDEX "PageChangeLog_sessionId_idx" ON "PageChangeLog"("sessionId");

-- CreateIndex
CREATE INDEX "PageChangeLog_shopifyPageId_idx" ON "PageChangeLog"("shopifyPageId");

-- CreateIndex
CREATE INDEX "PageChangeLog_handle_idx" ON "PageChangeLog"("handle");
