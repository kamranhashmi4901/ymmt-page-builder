import { authenticate } from "../shopify.server";

import { getYMMTPageSearchJob } from "../lib/ymmt-page-search-jobs.server";

export const loader = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);

  const job = await getYMMTPageSearchJob({
    jobId: params.jobId,

    shop: session.shop,
  });

  if (!job) {
    throw new Response("Search job not found.", {
      status: 404,
    });
  }

  let pages = [];
  let missingRecords = [];
  let searchMode = "json";
  let filters = {};

  try {
    const stored = JSON.parse(job.recordsJson || "[]");

    if (!Array.isArray(stored)) {
      searchMode = stored?.mode || "json";
      filters = stored?.filters || {};
    }
  } catch {
    searchMode = "json";
    filters = {};
  }

  if (job.status === "completed") {
    try {
      pages = JSON.parse(job.resultPagesJson || "[]");
    } catch {
      pages = [];
    }

    try {
      missingRecords = JSON.parse(job.missingRecordsJson || "[]");
    } catch {
      missingRecords = [];
    }
  }

  return {
    id: job.id,

    status: job.status,

    fileName: job.fileName,

    searchMode,

    filters,

    totalRecords: job.totalRecords,

    totalYears: job.totalYears,

    processedYears: job.processedYears,

    currentYear: job.currentYear,

    requestCount: job.requestCount,

    currentYearTotal: job.currentYearTotal,

    currentYearFound: job.currentYearFound,

    currentYearMissing: job.currentYearMissing,

    pagesFound: job.pagesFound,

    missingCount: job.missingCount,

    progress: job.progress,

    message: job.message,

    error: job.error,

    pages,

    missingRecords,
  };
};
