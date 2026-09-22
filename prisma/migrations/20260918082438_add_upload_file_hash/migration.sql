/*
  Warnings:

  - A unique constraint covering the columns `[shop,fileHash]` on the table `YmmtUpload` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "YmmtUpload" ADD COLUMN "fileHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "YmmtUpload_shop_fileHash_key" ON "YmmtUpload"("shop", "fileHash");
