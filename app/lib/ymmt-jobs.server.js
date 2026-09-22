import db from "../db.server";
import { buildYMMTPageHandle, buildYMMTPageTitle } from "./ymmt-pages";
import { createYMMTPage } from "./shopify-page-create.server";
import { getExistingPageHandles } from "./shopify-pages.server";

const activeJobs = new Set();

export async function createYMMTJob({ shop, uploadId }) {
  const records = await db.ymmtRecord.findMany({
    where: {
      uploadId,
      selected: true,
      duplicate: false,
    },
    select: { id: true },
  });

  if (!records.length) {
    throw new Error("No selected records available.");
  }

  return db.ymmtJob.create({
    data: {
      shop,
      uploadId,
      type: "create",
      status: "pending",
      total: records.length,
    },
  });
}

export async function getYMMTJob({ jobId, shop }) {
  return db.ymmtJob.findFirst({
    where: {
      id: jobId,
      shop,
    },
    include: {
      logs: {
        orderBy: { createdAt: "asc" },
        take: 100,
      },
    },
  });
}

async function logJob({
  jobId,
  level = "info",
  message,
  handle = null,
  recordId = null,
}) {
  await db.ymmtJobLog.create({
    data: {
      jobId,
      level,
      message,
      handle,
      recordId,
    },
  });
}

export async function pauseYMMTJob({ jobId, shop }) {
  return db.ymmtJob.updateMany({
    where: {
      id: jobId,
      shop,
      status: "running",
    },
    data: {
      status: "paused",
    },
  });
}

export async function resumeYMMTJob({ jobId, shop, admin }) {
  await db.ymmtJob.updateMany({
    where: {
      id: jobId,
      shop,
      status: "paused",
    },
    data: {
      status: "running",
    },
  });

  startYMMTJobProcessor({
    jobId,
    shop,
    admin,
  });
}

export async function cancelYMMTJob({ jobId, shop }) {
  await db.ymmtJob.updateMany({
    where: {
      id: jobId,
      shop,
      status: {
        in: ["pending", "running", "paused"],
      },
    },
    data: {
      status: "cancelled",
      finishedAt: new Date(),
    },
  });

  await logJob({
    jobId,
    level: "warning",
    message: "Job cancelled by user.",
  });
}

export function startYMMTJobProcessor({ jobId, shop, admin }) {
  if (activeJobs.has(jobId)) {
    return;
  }

  activeJobs.add(jobId);

  processJob({
    jobId,
    shop,
    admin,
  }).finally(() => {
    activeJobs.delete(jobId);
  });
}

async function processJob({ jobId, shop, admin }) {
  try {
    const job = await db.ymmtJob.findFirst({
      where: {
        id: jobId,
        shop,
      },
    });

    if (!job) return;

    const upload = await db.ymmtUpload.findFirst({
      where: {
        id: job.uploadId,
        shop,
      },
    });

    if (!upload) {
      throw new Error("YMMT upload not found.");
    }

    await db.ymmtJob.update({
      where: { id: jobId },
      data: {
        status: "running",
        startedAt: job.startedAt || new Date(),
      },
    });

    await logJob({
      jobId,
      message: "Creation job started.",
    });

    const existingHandles = await getExistingPageHandles(admin);

    const records = await db.ymmtRecord.findMany({
      where: {
        uploadId: job.uploadId,
        selected: true,
        duplicate: false,
      },
      orderBy: {
        id: "asc",
      },
    });

    /*
     * Skip records already processed by this job.
     * This makes resume safer.
     */
    const processedLogs = await db.ymmtJobLog.findMany({
      where: {
        jobId,
        recordId: {
          not: null,
        },
        level: {
          in: ["success", "skipped"],
        },
      },
      select: {
        recordId: true,
      },
    });

    const processedIds = new Set(
      processedLogs.map((log) => log.recordId).filter(Boolean),
    );

    for (const record of records) {
      if (processedIds.has(record.id)) {
        continue;
      }

      const currentJob = await db.ymmtJob.findUnique({
        where: { id: jobId },
      });

      if (!currentJob) return;

      if (currentJob.status === "cancelled") {
        return;
      }

      if (currentJob.status === "paused") {
        await logJob({
          jobId,
          message: "Job paused.",
        });

        return;
      }

      const handle = buildYMMTPageHandle(record, upload.sourceProductHandle);

      const title = buildYMMTPageTitle(record, upload.sourceProductHandle);

      if (existingHandles.has(handle)) {
        await db.$transaction([
          db.ymmtJob.update({
            where: { id: jobId },
            data: {
              processed: { increment: 1 },
              skipped: { increment: 1 },
            },
          }),

          db.ymmtJobLog.create({
            data: {
              jobId,
              level: "skipped",
              message: "Page already exists.",
              handle,
              recordId: record.id,
            },
          }),
        ]);

        continue;
      }

      try {
        await createYMMTPage(admin, {
          title,
          handle,
          record,
          sourceProductHandle: upload.sourceProductHandle,
        });

        existingHandles.add(handle);

        await db.$transaction([
          db.ymmtJob.update({
            where: { id: jobId },
            data: {
              processed: { increment: 1 },
              created: { increment: 1 },
            },
          }),

          db.ymmtJobLog.create({
            data: {
              jobId,
              level: "success",
              message: "Page created successfully.",
              handle,
              recordId: record.id,
            },
          }),
        ]);
      } catch (error) {
        await db.$transaction([
          db.ymmtJob.update({
            where: { id: jobId },
            data: {
              processed: { increment: 1 },
              failed: { increment: 1 },
            },
          }),

          db.ymmtJobLog.create({
            data: {
              jobId,
              level: "error",
              message: error.message || "Unknown page creation error.",
              handle,
              recordId: record.id,
            },
          }),
        ]);
      }
    }

    const finishedJob = await db.ymmtJob.findUnique({
      where: { id: jobId },
    });

    if (finishedJob && finishedJob.status === "running") {
      await db.ymmtJob.update({
        where: { id: jobId },
        data: {
          status: "completed",
          finishedAt: new Date(),
        },
      });

      await logJob({
        jobId,
        message: "Creation job completed.",
      });
    }
  } catch (error) {
    await db.ymmtJob.update({
      where: { id: jobId },
      data: {
        status: "failed",
        finishedAt: new Date(),
      },
    });

    await logJob({
      jobId,
      level: "error",
      message: error.message || "Job failed unexpectedly.",
    });
  }
}
