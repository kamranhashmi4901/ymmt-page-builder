import db from "../db.server";

import {
  searchYMMTPagesByFilters,
  searchYMMTPagesByRecords,
} from "./shopify-manage-pages.server";

const activeSearchJobs = new Set();

export async function createYMMTPageSearchJob({
  shop,
  fileName = null,
  records = [],
  mode = "json",
  filters = {},
}) {
  const safeRecords = Array.isArray(records) ? records : [];

  const years = [
    ...new Set(
      safeRecords
        .map((record) => String(record.year || "").trim())
        .filter(Boolean),
    ),
  ];

  const payload = {
    mode,
    filters,
    records: safeRecords,
  };

  return db.ymmtPageSearchJob.create({
    data: {
      shop,
      status: "pending",
      fileName: fileName || (mode === "manual" ? "Manual Search" : null),
      totalRecords: mode === "manual" ? 0 : safeRecords.length,
      totalYears:
        mode === "manual"
          ? String(filters.year || "").trim()
            ? 1
            : 0
          : years.length,
      recordsJson: JSON.stringify(payload),
      message: mode === "manual" ? "Manual search queued." : "Search queued.",
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

    let mode = "json";
    let records = [];
    let filters = {};

    try {
      const stored = JSON.parse(job.recordsJson || "[]");

      // Backward compatibility with old JSON-search jobs.
      if (Array.isArray(stored)) {
        records = stored;
      } else {
        mode = stored?.mode || "json";
        records = Array.isArray(stored?.records) ? stored.records : [];
        filters = stored?.filters || {};
      }
    } catch {
      throw new Error("Unable to read stored YMMT search data.");
    }

    await db.ymmtPageSearchJob.update({
      where: {
        id: jobId,
      },

      data: {
        status: "running",

        startedAt: job.startedAt || new Date(),

        message:
          mode === "manual"
            ? "Starting manual Shopify page search..."
            : "Starting Shopify page search...",
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

    const result =
      mode === "manual"
        ? await searchYMMTPagesByFilters(admin, filters, {
            onProgress: updateProgress,
          })
        : await searchYMMTPagesByRecords(admin, records, {
            onProgress: updateProgress,
          });

    await db.ymmtPageSearchJob.update({
      where: {
        id: jobId,
      },

      data: {
        status: "completed",

        progress: 100,

        pagesFound: result.pages.length,

        missingCount: result.missingRecords?.length || 0,

        resultPagesJson: JSON.stringify(result.pages),

        missingRecordsJson: JSON.stringify(result.missingRecords || []),

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
