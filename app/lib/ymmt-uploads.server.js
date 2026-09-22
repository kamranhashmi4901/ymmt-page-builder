import db from "../db.server";

export async function saveYMMTUpload({
  shop,
  fileName,
  fileHash,
  entries,
  stats,
}) {
  return db.$transaction(async (tx) => {
    const upload = await tx.ymmtUpload.create({
      data: {
        shop,
        fileName,
        fileHash,
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

export async function getYMMTFilterOptions({ uploadId, shop }) {
  const upload = await db.ymmtUpload.findFirst({
    where: { id: uploadId, shop },
  });

  if (!upload) return null;

  const records = await db.ymmtRecord.findMany({
    where: { uploadId },
    select: {
      year: true,
      make: true,
      model: true,
      trim: true,
      manufacturer: true,
    },
  });

  return {
    upload,
    years: [...new Set(records.map((r) => r.year))].sort(),
    makes: [...new Set(records.map((r) => r.make))].sort(),
    models: [...new Set(records.map((r) => r.model))].sort(),
    trims: [
      ...new Set(
        records
          .map((r) => r.trim)
          .filter((trim) => trim && trim.toLowerCase() !== "all"),
      ),
    ].sort(),
    manufacturers: [
      ...new Set(records.map((r) => r.manufacturer).filter(Boolean)),
    ].sort(),
  };
}

export async function getFilteredYMMTRecords({
  uploadId,
  year,
  make,
  model,
  trim,
  manufacturer,
  page = 1,
  pageSize = 25,
}) {
  const where = {
    uploadId,
    ...(year && { year }),
    ...(make && { make }),
    ...(model && { model }),
    ...(trim && {
      trim: trim === "__NO_TRIM__" ? null : trim,
    }),
    ...(manufacturer && { manufacturer }),
  };

  const [records, total] = await Promise.all([
    db.ymmtRecord.findMany({
      where,
      orderBy: [
        { year: "asc" },
        { make: "asc" },
        { model: "asc" },
        { trim: "asc" },
      ],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.ymmtRecord.count({ where }),
  ]);

  return {
    records,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export async function findUploadByHash({ shop, fileHash }) {
  return db.ymmtUpload.findUnique({
    where: {
      shop_fileHash: {
        shop,
        fileHash,
      },
    },
  });
}
