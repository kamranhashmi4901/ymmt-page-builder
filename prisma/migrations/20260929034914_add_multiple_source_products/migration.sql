-- CreateTable
CREATE TABLE "YmmtUploadProduct" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "uploadId" TEXT NOT NULL,
    "productId" TEXT,
    "title" TEXT,
    "handle" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "YmmtUploadProduct_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "YmmtUpload" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "YmmtUploadProduct_uploadId_idx" ON "YmmtUploadProduct"("uploadId");

-- CreateIndex
CREATE UNIQUE INDEX "YmmtUploadProduct_uploadId_handle_key" ON "YmmtUploadProduct"("uploadId", "handle");
