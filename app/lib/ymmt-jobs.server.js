import db from "../db.server";

import { buildYMMTPageHandle, buildYMMTPageTitle } from "./ymmt-pages";

import { createYMMTPage } from "./shopify-page-create.server";

import { getExistingPageHandles } from "./shopify-pages.server";

const activeJobs = new Set();

/*
 * Return selected products.
 */
function getSourceProducts(upload) {
  return upload.sourceProducts?.length > 0 ? upload.sourceProducts : [null];
}

/*
 * Build one page proposal for every:
 *
 * vehicle × product
 */
function buildPageProposals(record, upload) {
  return getSourceProducts(upload).map((product) => {
    const sourceProductHandle = product?.handle || null;

    return {
      product,

      sourceProductHandle,

      handle: buildYMMTPageHandle(record, sourceProductHandle),

      title: buildYMMTPageTitle(record, sourceProductHandle),
    };
  });
}

/* =========================================================
   CREATE JOB
========================================================= */

export async function createYMMTJob({ shop, uploadId }) {
  const upload = await db.ymmtUpload.findFirst({
    where: {
      id: uploadId,

      shop,
    },

    include: {
      sourceProducts: {
        orderBy: {
          createdAt: "asc",
        },
      },
    },
  });

  if (!upload) {
    throw new Error("YMMT upload not found.");
  }

  const records = await db.ymmtRecord.findMany({
    where: {
      uploadId,

      selected: true,

      duplicate: false,
    },

    select: {
      id: true,
    },
  });

  if (!records.length) {
    throw new Error("No selected records available.");
  }

  const productCount = getSourceProducts(upload).length;

  const total = records.length * productCount;

  return db.ymmtJob.create({
    data: {
      shop,
      uploadId,

      type: "create",

      status: "pending",

      total,
    },
  });
}

/* =========================================================
   GET JOB
========================================================= */

export async function getYMMTJob({ jobId, shop }) {
  return db.ymmtJob.findFirst({
    where: {
      id: jobId,

      shop,
    },

    include: {
      logs: {
        orderBy: {
          createdAt: "asc",
        },

        take: 100,
      },
    },
  });
}

/* =========================================================
   LOG HELPER
========================================================= */

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

/* =========================================================
   PAUSE
========================================================= */

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

/* =========================================================
   RESUME
========================================================= */

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

/* =========================================================
   CANCEL
========================================================= */

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

/* =========================================================
   START PROCESSOR
========================================================= */

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

async function getCurrentJobStatus(jobId) {
  return db.ymmtJob.findUnique({
    where: {
      id: jobId,
    },

    select: {
      status: true,
    },
  });
}

/* =========================================================
   MAIN PROCESSOR
========================================================= */

async function processJob({ jobId, shop, admin }) {
  try {
    const job = await db.ymmtJob.findFirst({
      where: {
        id: jobId,

        shop,
      },
    });

    if (!job) {
      return;
    }

    const upload = await db.ymmtUpload.findFirst({
      where: {
        id: job.uploadId,

        shop,
      },

      include: {
        sourceProducts: {
          orderBy: {
            createdAt: "asc",
          },
        },
      },
    });

    if (!upload) {
      throw new Error("YMMT upload not found.");
    }

    const sourceProducts = getSourceProducts(upload);

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

    if (!records.length) {
      throw new Error("No selected records available.");
    }

    const expectedTotal = records.length * sourceProducts.length;

    await db.ymmtJob.update({
      where: {
        id: jobId,
      },

      data: {
        status: "running",

        startedAt: job.startedAt || new Date(),

        total: expectedTotal,
      },
    });

    await logJob({
      jobId,

      message:
        `Creation job started. ` +
        `${records.length} selected vehicle record(s) × ` +
        `${sourceProducts.length} product selection(s) = ` +
        `${expectedTotal} page combination(s).`,
    });

    /*
     * IMPORTANT:
     *
     * OLD:
     * getExistingPageHandles(admin)
     *
     * That scanned the entire Shopify store.
     *
     * NEW:
     * Build only the handles this job is
     * actually going to create.
     */
    const candidateHandles = records.flatMap((record) =>
      buildPageProposals(record, upload).map((proposal) => proposal.handle),
    );

    const existingHandles = await getExistingPageHandles(
      admin,
      candidateHandles,
    );

    /*
     * Resume safety.
     *
     * Track already completed
     * combinations by handle because
     * one vehicle can have multiple
     * product pages.
     */
    const processedLogs = await db.ymmtJobLog.findMany({
      where: {
        jobId,

        handle: {
          not: null,
        },

        level: {
          in: ["success", "skipped"],
        },
      },

      select: {
        handle: true,
      },
    });

    const processedHandles = new Set(
      processedLogs.map((log) => log.handle).filter(Boolean),
    );

    /*
     * Vehicle loop.
     */
    for (const record of records) {
      const proposals = buildPageProposals(record, upload);

      /*
       * Product loop.
       */
      for (const proposal of proposals) {
        const { sourceProductHandle, handle, title } = proposal;

        /*
         * Already processed by this job.
         */
        if (processedHandles.has(handle)) {
          continue;
        }

        const currentJob = await getCurrentJobStatus(jobId);

        if (!currentJob) {
          return;
        }

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

        /*
         * Existing page found by targeted
         * lookup.
         */
        if (existingHandles.has(handle)) {
          await db.$transaction([
            db.ymmtJob.update({
              where: {
                id: jobId,
              },

              data: {
                processed: {
                  increment: 1,
                },

                skipped: {
                  increment: 1,
                },
              },
            }),

            db.ymmtJobLog.create({
              data: {
                jobId,

                level: "skipped",

                message: sourceProductHandle
                  ? `Page already exists for product "${sourceProductHandle}".`
                  : "Page already exists.",

                handle,

                recordId: record.id,
              },
            }),
          ]);

          processedHandles.add(handle);

          continue;
        }

        /*
         * Create page.
         */
        try {
          await createYMMTPage(admin, {
            title,
            handle,
            record,
            sourceProductHandle,
          });

          /*
           * Immediately add new handle
           * to in-memory sets so this job
           * can never create it twice.
           */
          existingHandles.add(handle);

          processedHandles.add(handle);

          await db.$transaction([
            db.ymmtJob.update({
              where: {
                id: jobId,
              },

              data: {
                processed: {
                  increment: 1,
                },

                created: {
                  increment: 1,
                },
              },
            }),

            db.ymmtJobLog.create({
              data: {
                jobId,

                level: "success",

                message: sourceProductHandle
                  ? `Page created successfully for product "${sourceProductHandle}".`
                  : "Page created successfully.",

                handle,

                recordId: record.id,
              },
            }),
          ]);
        } catch (error) {
          /*
           * One page failed.
           * Continue with remaining pages.
           */
          await db.$transaction([
            db.ymmtJob.update({
              where: {
                id: jobId,
              },

              data: {
                processed: {
                  increment: 1,
                },

                failed: {
                  increment: 1,
                },
              },
            }),

            db.ymmtJobLog.create({
              data: {
                jobId,

                level: "error",

                message: error?.message || "Unknown page creation error.",

                handle,

                recordId: record.id,
              },
            }),
          ]);
        }
      }
    }

    const finishedJob = await db.ymmtJob.findUnique({
      where: {
        id: jobId,
      },
    });

    if (finishedJob && finishedJob.status === "running") {
      await db.ymmtJob.update({
        where: {
          id: jobId,
        },

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
    const currentJob = await db.ymmtJob.findUnique({
      where: {
        id: jobId,
      },

      select: {
        status: true,
      },
    });

    if (currentJob && currentJob.status !== "cancelled") {
      await db.ymmtJob.update({
        where: {
          id: jobId,
        },

        data: {
          status: "failed",

          finishedAt: new Date(),
        },
      });
    }

    await logJob({
      jobId,

      level: "error",

      message: error?.message || "Job failed unexpectedly.",
    });
  }
}
