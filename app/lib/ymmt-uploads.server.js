import db from "../db.server";

export async function saveYMMTUpload({ shop, fileName, entries, stats }) {
  return db.$transaction(async (tx) => {
    const upload = await tx.ymmtUpload.create({
      data: {
        shop,
        fileName,
        totalRecords: stats.totalEntries,
        totalYears: stats.totalYears,
        totalMakes: stats.totalMakes,
        totalModels: stats.totalModels,
        totalTrims: stats.totalTrims,
        withTrim: stats.withTrim,
        withoutTrim: stats.withoutTrim,
      },
    });

    await tx.ymmtRecord.createMany({
      data: entries.map((entry) => ({
        uploadId: upload.id,
        year: entry.year,
        make: entry.make,
        model: entry.model,
        trim: entry.trim,
        warning: entry.warning,
        compatible: entry.compatible,
        manufacturer: entry.manufacturer,
      })),
    });

    return upload;
  });
}

export async function getYMMTUpload({ uploadId, shop }) {
  return db.ymmtUpload.findFirst({
    where: {
      id: uploadId,
      shop,
    },
  });
}

export async function setSourceProductHandle({
  uploadId,
  shop,
  sourceProductHandle,
}) {
  return db.ymmtUpload.updateMany({
    where: {
      id: uploadId,
      shop,
    },
    data: {
      sourceProductHandle,
    },
  });
}
