import db from "../db.server";

import { searchYMMTPagesByRecords } from "./shopify-manage-pages.server";

const activeSearchJobs = new Set();

export async function createYMMTPageSearchJob({ shop, fileName, records }) {
  const years = [
    ...new Set(
      records.map((record) => String(record.year || "").trim()).filter(Boolean),
    ),
  ];

  return db.ymmtPageSearchJob.create({
    data: {
      shop,

      status: "pending",

      fileName: fileName || null,

      totalRecords: records.length,

      totalYears: years.length,

      recordsJson: JSON.stringify(records),

      message: "Search queued.",
    },
  });
}

export async function getYMMTPageSearchJob({ jobId, shop }) {
  return db.ymmtPageSearchJob.findFirst({
    where: {
      id: jobId,
      shop,
    },
  });
}

export function startYMMTPageSearchJob({ jobId, shop, admin }) {
  if (activeSearchJobs.has(jobId)) {
    return;
  }

  activeSearchJobs.add(jobId);

  processSearchJob({
    jobId,
    shop,
    admin,
  }).finally(() => {
    activeSearchJobs.delete(jobId);
  });
}

async function processSearchJob({ jobId, shop, admin }) {
  try {
    const job = await db.ymmtPageSearchJob.findFirst({
      where: {
        id: jobId,
        shop,
      },
    });

    if (!job) {
      return;
    }

    let records = [];

    try {
      records = JSON.parse(job.recordsJson || "[]");
    } catch {
      throw new Error("Unable to read stored YMMT search records.");
    }

    await db.ymmtPageSearchJob.update({
      where: {
        id: jobId,
      },

      data: {
        status: "running",

        startedAt: job.startedAt || new Date(),

        message: "Starting Shopify page search...",
      },
    });

    const updateProgress = async (progressData) => {
      await db.ymmtPageSearchJob.update({
        where: {
          id: jobId,
        },

        data: {
          currentYear: progressData.currentYear ?? undefined,

          processedYears: progressData.processedYears ?? undefined,

          requestCount: progressData.requestCount ?? undefined,

          currentYearTotal: progressData.currentYearTotal ?? undefined,

          currentYearFound: progressData.currentYearFound ?? undefined,

          currentYearMissing: progressData.currentYearMissing ?? undefined,

          pagesFound: progressData.pagesFound ?? undefined,

          missingCount: progressData.missingCount ?? undefined,

          progress: progressData.progress ?? undefined,

          message: progressData.message ?? undefined,
        },
      });
    };

    const result = await searchYMMTPagesByRecords(
      admin,
      records,

      {
        onProgress: updateProgress,
      },
    );

    await db.ymmtPageSearchJob.update({
      where: {
        id: jobId,
      },

      data: {
        status: "completed",

        progress: 100,

        pagesFound: result.pages.length,

        missingCount: result.missingRecords.length,

        resultPagesJson: JSON.stringify(result.pages),

        missingRecordsJson: JSON.stringify(result.missingRecords),

        message: "Search completed.",

        finishedAt: new Date(),
      },
    });
  } catch (error) {
    await db.ymmtPageSearchJob.update({
      where: {
        id: jobId,
      },

      data: {
        status: "failed",

        error: error?.message || "Page search failed.",

        message: "Search failed.",

        finishedAt: new Date(),
      },
    });
  }
}
