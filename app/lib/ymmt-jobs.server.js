import db from "../db.server";

import { buildYMMTPageHandle, buildYMMTPageTitle } from "./ymmt-pages";

import { createYMMTPage } from "./shopify-page-create.server";
import { getExistingPageHandles } from "./shopify-pages.server";

const activeJobs = new Set();

/*
 * Return the selected products for this upload.
 *
 * If no product was selected, keep the old behavior:
 * create one page without a product suffix.
 */
function getSourceProducts(upload) {
  return upload.sourceProducts?.length > 0 ? upload.sourceProducts : [null];
}

/*
 * Build one page proposal for every combination:
 *
 * YMMT record × selected product
 *
 * Example:
 * 1 vehicle × 3 products = 3 page proposals
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

/*
 * Create a new background creation job.
 *
 * IMPORTANT:
 * total now means the real number of Shopify pages:
 *
 * selected vehicles × selected products
 */
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

/*
 * Read a job together with the latest logs.
 */
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

/*
 * Small helper used throughout the processor.
 */
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

/*
 * Pause the job.
 */
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

/*
 * Resume the job.
 */
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

/*
 * Cancel the job.
 */
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

/*
 * Prevent the same job from running more than once
 * inside the current Node process.
 */
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

/*
 * Read only the current job status.
 *
 * We check this before every individual page so pause/cancel
 * reacts even while one vehicle has multiple products.
 */
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

/*
 * Main creation processor.
 */
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

    /*
     * IMPORTANT:
     * We must include sourceProducts here.
     *
     * Without this, the processor would fall back
     * to the old single-product behavior.
     */
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

    /*
     * Recalculate total at processor start.
     *
     * Example:
     * 10 vehicles × 3 products = 30 pages
     */
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
     * Existing Shopify handles.
     *
     * New handles created during this job are also added
     * to this Set so we never create duplicates in the
     * same job.
     */
    const existingHandles = await getExistingPageHandles(admin);

    /*
     * Resume safety.
     *
     * OLD VERSION:
     * processed by recordId only.
     *
     * That does NOT work with multiple products because:
     *
     * record A + product 1 may be completed
     * record A + product 2 may still be pending
     *
     * Therefore we track processed combinations by HANDLE.
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
      /*
       * Build every selected product page for this vehicle.
       */
      const proposals = buildPageProposals(record, upload);

      /*
       * Product loop.
       */
      for (const proposal of proposals) {
        const { sourceProductHandle, handle, title } = proposal;

        /*
         * If this exact page was already completed by
         * this same job before pause/resume, skip it.
         */
        if (processedHandles.has(handle)) {
          continue;
        }

        /*
         * Check current job status before each page.
         */
        const currentJob = await getCurrentJobStatus(jobId);

        if (!currentJob) {
          return;
        }

        /*
         * Stop immediately if user cancelled.
         */
        if (currentJob.status === "cancelled") {
          return;
        }

        /*
         * Stop safely if user paused.
         */
        if (currentJob.status === "paused") {
          await logJob({
            jobId,
            message: "Job paused.",
          });

          return;
        }

        /*
         * If page already exists in Shopify,
         * mark this combination as skipped.
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
         * Create the actual Shopify page.
         */
        try {
          await createYMMTPage(admin, {
            title,
            handle,
            record,

            /*
             * This is the important part:
             * every page receives its own selected product handle.
             */
            sourceProductHandle,
          });

          /*
           * Add newly-created handle immediately so another
           * combination in this same job cannot recreate it.
           */
          existingHandles.add(handle);

          processedHandles.add(handle);

          /*
           * Mark success.
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
           *
           * We do NOT fail the whole job.
           * Continue to the next product/page.
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

    /*
     * Everything has finished.
     */
    const finishedJob = await db.ymmtJob.findUnique({
      where: {
        id: jobId,
      },
    });

    /*
     * Only mark completed when the user did not
     * pause or cancel the job.
     */
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
    /*
     * Read status first so an explicitly cancelled
     * job is not accidentally changed to failed.
     */
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
