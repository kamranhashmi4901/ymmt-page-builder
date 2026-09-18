-- CreateTable
CREATE TABLE "YmmtUpload" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "stats" JSONB NOT NULL,
    "sourceProductId" TEXT,
    "sourceProductHandle" TEXT,
    "sourceProductTitle" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "YmmtRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "uploadId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "year" TEXT NOT NULL,
    "make" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "trim" TEXT,
    "warning" TEXT NOT NULL,
    "compatible" TEXT NOT NULL,
    "manufacturer" TEXT NOT NULL,
    CONSTRAINT "YmmtRecord_uploadId_shop_fkey" FOREIGN KEY ("uploadId", "shop") REFERENCES "YmmtUpload" ("id", "shop") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "YmmtUpload_shop_createdAt_idx" ON "YmmtUpload"("shop", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "YmmtUpload_id_shop_key" ON "YmmtUpload"("id", "shop");

-- CreateIndex
CREATE INDEX "YmmtRecord_shop_uploadId_year_make_model_idx" ON "YmmtRecord"("shop", "uploadId", "year", "make", "model");

-- CreateIndex
CREATE UNIQUE INDEX "YmmtRecord_uploadId_position_key" ON "YmmtRecord"("uploadId", "position");

