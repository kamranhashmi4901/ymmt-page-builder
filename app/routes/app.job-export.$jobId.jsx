import db from "../db.server";
import { authenticate } from "../shopify.server";

/*
 * Escape a value so it is safe inside a CSV cell.
 */
function csvCell(value) {
  const stringValue = String(value ?? "");

  return `"${stringValue.replace(/"/g, '""')}"`;
}

/*
 * Build a public Shopify page URL.
 *
 * session.shop is normally:
 * everseats.myshopify.com
 *
 * Shopify pages use:
 * /pages/{handle}
 */
function buildPageUrl(shop, handle) {
  if (!shop || !handle) {
    return "";
  }

  return `https://${shop}/pages/${handle}`;
}

/*
 * GET /app/job-export/:jobId
 *
 * Downloads ONLY pages successfully created by this job.
 *
 * Skipped pages are not included.
 * Failed pages are not included.
 */
export const loader = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);

  const jobId = params.jobId;

  if (!jobId) {
    throw new Response("Missing job ID.", {
      status: 400,
    });
  }

  /*
   * First verify that this job belongs to the current shop.
   */
  const job = await db.ymmtJob.findFirst({
    where: {
      id: jobId,
      shop: session.shop,
    },

    select: {
      id: true,
      shop: true,
      uploadId: true,
      status: true,
      created: true,
      createdAt: true,
      finishedAt: true,
    },
  });

  if (!job) {
    throw new Response("Job not found.", {
      status: 404,
    });
  }

  /*
   * Get every SUCCESS log.
   *
   * IMPORTANT:
   * We query the database directly instead of using getYMMTJob()
   * because getYMMTJob() only returns the first 100 logs.
   *
   * A creation job may contain thousands of pages.
   */
  const successLogs = await db.ymmtJobLog.findMany({
    where: {
      jobId: job.id,
      level: "success",

      handle: {
        not: null,
      },

      recordId: {
        not: null,
      },
    },

    orderBy: {
      createdAt: "asc",
    },

    select: {
      id: true,
      handle: true,
      recordId: true,
      message: true,
      createdAt: true,
    },
  });

  /*
   * Fetch the YMMT records used by those successful pages.
   *
   * One record may have multiple success logs because:
   *
   * vehicle × multiple products
   *
   * Example:
   *
   * Honda Accord
   *   → Luxeline
   *   → TriQuilt
   *   → SilverStone
   */
  const recordIds = [
    ...new Set(successLogs.map((log) => log.recordId).filter(Boolean)),
  ];

  const records =
    recordIds.length > 0
      ? await db.ymmtRecord.findMany({
          where: {
            id: {
              in: recordIds,
            },

            uploadId: job.uploadId,
          },
        })
      : [];

  const recordMap = new Map(records.map((record) => [record.id, record]));

  /*
   * Get the products selected for this upload.
   *
   * We use these handles to determine which product belongs
   * to each created page.
   */
  const upload = await db.ymmtUpload.findFirst({
    where: {
      id: job.uploadId,
      shop: session.shop,
    },

    include: {
      sourceProducts: {
        orderBy: {
          createdAt: "asc",
        },
      },
    },
  });

  const sourceProducts = upload?.sourceProducts || [];

  /*
   * Sort longest handles first.
   *
   * This avoids a shorter product handle accidentally matching
   * before a longer one.
   */
  const productHandles = sourceProducts
    .map((product) => ({
      handle: String(product.handle || "").trim(),

      title: String(product.title || "").trim(),
    }))
    .filter((product) => product.handle)
    .sort((a, b) => b.handle.length - a.handle.length);

  /*
   * Determine the product from the final page handle.
   *
   * Example:
   *
   * 1999-honda-accord-base-luxeline-seat-covers
   *
   * → luxeline-seat-covers
   */
  function getProductForHandle(pageHandle) {
    const normalizedPageHandle = String(pageHandle || "")
      .trim()
      .toLowerCase();

    for (const product of productHandles) {
      const normalizedProductHandle = product.handle.toLowerCase();

      if (
        normalizedPageHandle.endsWith(`-${normalizedProductHandle}`) ||
        normalizedPageHandle === normalizedProductHandle
      ) {
        return product;
      }
    }

    return {
      handle: "",
      title: "",
    };
  }

  /*
   * CSV columns.
   */
  const headers = [
    "Page Title",
    "Page Handle",
    "Page URL",
    "Year",
    "Make",
    "Model",
    "Trim",
    "Manufacturer",
    "Compatibility",
    "Warning",
    "Product Handle",
    "Product Title",
    "Status",
    "Created At",
  ];

  const rows = [];

  for (const log of successLogs) {
    const record = recordMap.get(log.recordId);

    if (!record) {
      /*
       * This should normally never happen, but don't make the
       * entire export fail because of one missing DB record.
       */
      continue;
    }

    const product = getProductForHandle(log.handle);

    /*
     * Build the same human-readable title format used by
     * page creation.
     *
     * IMPORTANT:
     * The actual final Shopify handle comes from the success log.
     * We do NOT rebuild the handle here.
     */
    const titleParts = [record.year, record.make, record.model];

    /*
     * Only display trim if the record actually has one.
     *
     * This preserves the source record instead of inventing
     * "Base" for vehicles that have no trim.
     */
    if (String(record.trim || "").trim()) {
      titleParts.push(record.trim);
    }

    if (product.handle) {
      titleParts.push(product.handle);
    }

    const pageTitle = titleParts.filter(Boolean).join(" ");

    const pageUrl = buildPageUrl(session.shop, log.handle);

    rows.push([
      pageTitle,
      log.handle,
      pageUrl,
      record.year || "",
      record.make || "",
      record.model || "",
      record.trim || "",
      record.manufacturer || "",

      record.compatible || record.compatibility || "",

      record.warning || "",
      product.handle,
      product.title,
      "Created",

      log.createdAt ? new Date(log.createdAt).toISOString() : "",
    ]);
  }

  /*
   * Convert everything into CSV.
   */
  const csvLines = [
    headers.map(csvCell).join(","),

    ...rows.map((row) => row.map(csvCell).join(",")),
  ];

  /*
   * BOM helps Excel correctly detect UTF-8 characters.
   */
  const csv = "\uFEFF" + csvLines.join("\r\n");

  const safeDate = new Date().toISOString().slice(0, 10);

  const filename = `ymmt-created-pages-${safeDate}-${job.id}.csv`;

  return new Response(csv, {
    status: 200,

    headers: {
      "Content-Type": "text/csv; charset=utf-8",

      "Content-Disposition": `attachment; filename="${filename}"`,

      "Cache-Control": "no-store",
    },
  });
};
