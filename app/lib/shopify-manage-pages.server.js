import { buildYMMTPageContent } from "./ymmt-page-content.server";
import { buildYMMTVehicleHandleBase } from "./ymmt-pages";

/* =========================================================
   UPDATE PAGE CONTENT
========================================================= */

export async function updateYMMTPageContent(admin, pageId) {
  const response = await admin.graphql(
    `#graphql
      query GetYMMTVehicle($id: ID!) {
        page(id: $id) {
          id

          vehicle: metafield(
            namespace: "ymmt"
            key: "vehicle"
          ) {
            value
          }
        }
      }
    `,
    {
      variables: {
        id: pageId,
      },
    },
  );

  const json = await response.json();

  if (json.errors?.length) {
    throw new Error(json.errors.map((error) => error.message).join(", "));
  }

  const page = json.data?.page;

  if (!page) {
    throw new Error(`Unable to find Shopify page ${pageId}.`);
  }

  if (!page.vehicle?.value) {
    throw new Error("This page does not contain a ymmt.vehicle metafield.");
  }

  let record;

  try {
    record = JSON.parse(page.vehicle.value);
  } catch {
    throw new Error("The ymmt.vehicle metafield contains invalid JSON.");
  }

  const { pageBody } = buildYMMTPageContent(record);

  const updateResponse = await admin.graphql(
    `#graphql
        mutation UpdateYMMTPageContent(
          $id: ID!
          $page: PageUpdateInput!
        ) {
          pageUpdate(
            id: $id
            page: $page
          ) {
            page {
              id
              title
              handle
            }

            userErrors {
              field
              message
            }
          }
        }
      `,
    {
      variables: {
        id: pageId,

        page: {
          body: pageBody,
        },
      },
    },
  );

  const updateJson = await updateResponse.json();

  if (updateJson.errors?.length) {
    throw new Error(updateJson.errors.map((error) => error.message).join(", "));
  }

  const result = updateJson.data?.pageUpdate;

  if (result?.userErrors?.length) {
    throw new Error(result.userErrors.map((error) => error.message).join(", "));
  }

  return result?.page;
}

/* =========================================================
   MANUAL SEARCH
========================================================= */

export async function searchYMMTPages(admin, filters = {}) {
  const pages = [];

  let requestCount = 0;
  const MAX_REQUESTS = 20;

  let cursor = null;
  let hasNextPage = true;

  const shopifyQueryParts = [];

  if (filters.search) {
    shopifyQueryParts.push(filters.search);
  }

  if (filters.status === "published") {
    shopifyQueryParts.push("published_status:published");
  }

  if (filters.status === "draft") {
    shopifyQueryParts.push("published_status:unpublished");
  }

  const shopifyQuery = shopifyQueryParts.join(" AND ");

  while (hasNextPage) {
    if (requestCount >= MAX_REQUESTS) {
      break;
    }

    requestCount += 1;

    const response = await admin.graphql(
      `#graphql
        query ManagePages(
          $after: String
          $query: String
        ) {
          pages(
            first: 100
            after: $after
            query: $query
          ) {
            nodes {
              id
              title
              handle
              templateSuffix
              isPublished

              vehicle: metafield(
                namespace: "ymmt"
                key: "vehicle"
              ) {
                value
              }

              productHandle: metafield(
                namespace: "ymmt"
                key: "product_handle"
              ) {
                value
              }

              sourceProductHandle: metafield(
                namespace: "ymmt"
                key: "source_product_handle"
              ) {
                value
              }
            }

            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `,
      {
        variables: {
          after: cursor,
          query: shopifyQuery || null,
        },
      },
    );

    const json = await response.json();

    if (json.errors?.length) {
      throw new Error(json.errors.map((error) => error.message).join(", "));
    }

    const connection = json.data?.pages;

    if (!connection) {
      break;
    }

    for (const page of connection.nodes) {
      if (page.templateSuffix !== "product-ymmt") {
        continue;
      }

      let vehicle = {};

      try {
        vehicle = page.vehicle?.value ? JSON.parse(page.vehicle.value) : {};
      } catch {
        vehicle = {};
      }

      const pageData = {
        id: page.id,
        title: page.title,
        handle: page.handle,
        templateSuffix: page.templateSuffix,
        isPublished: page.isPublished,

        productHandle: page.productHandle?.value || "",

        sourceProductHandle: page.sourceProductHandle?.value || "",

        year: String(vehicle.year || ""),
        make: String(vehicle.make || ""),
        model: String(vehicle.model || ""),
        trim: String(vehicle.trim || ""),

        manufacturer: String(vehicle.manufacturer || ""),

        compatibility: String(vehicle.compatible || vehicle.compat || ""),

        warning: String(vehicle.warning || ""),
      };

      const normalize = (value) =>
        String(value || "")
          .trim()
          .toLowerCase();

      const exactMatch = (value, filter) =>
        !normalize(filter) || normalize(value) === normalize(filter);

      const partialMatch = (value, filter) =>
        !normalize(filter) || normalize(value).includes(normalize(filter));

      const matches =
        partialMatch(`${pageData.title} ${pageData.handle}`, filters.search) &&
        exactMatch(pageData.year, filters.year) &&
        partialMatch(pageData.make, filters.make) &&
        partialMatch(pageData.model, filters.model) &&
        partialMatch(pageData.trim, filters.trim) &&
        partialMatch(pageData.manufacturer, filters.manufacturer) &&
        partialMatch(pageData.compatibility, filters.compatibility) &&
        partialMatch(pageData.warning, filters.warning) &&
        partialMatch(pageData.productHandle, filters.productHandle) &&
        (!filters.status ||
          (filters.status === "published" && pageData.isPublished) ||
          (filters.status === "draft" && !pageData.isPublished));

      if (matches) {
        pages.push(pageData);
      }
    }

    hasNextPage = connection.pageInfo.hasNextPage;

    cursor = connection.pageInfo.endCursor;
  }

  return pages;
}

/* =========================================================
   DELETE PAGE
========================================================= */

export async function deleteShopifyPage(admin, pageId) {
  const response = await admin.graphql(
    `#graphql
      mutation DeletePage(
        $id: ID!
      ) {
        pageDelete(
          id: $id
        ) {
          deletedPageId

          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      variables: {
        id: pageId,
      },
    },
  );

  const json = await response.json();

  if (json.errors?.length) {
    throw new Error(json.errors.map((error) => error.message).join(", "));
  }

  const result = json.data?.pageDelete;

  if (result?.userErrors?.length) {
    throw new Error(result.userErrors.map((error) => error.message).join(", "));
  }

  return result?.deletedPageId;
}

/* =========================================================
   UPDATE PRODUCT HANDLE
========================================================= */

export async function updateYMMTProductHandle(
  admin,
  { pageId, productHandle },
) {
  const metafields = [];

  if (productHandle) {
    metafields.push({
      namespace: "ymmt",
      key: "product_handle",
      type: "single_line_text_field",
      value: productHandle,
    });

    metafields.push({
      namespace: "ymmt",
      key: "source_product_handle",
      type: "single_line_text_field",
      value: productHandle,
    });
  }

  const page = {
    templateSuffix: "product-ymmt",
  };

  if (metafields.length > 0) {
    page.metafields = metafields;
  }

  const response = await admin.graphql(
    `#graphql
      mutation UpdatePage(
        $id: ID!
        $page: PageUpdateInput!
      ) {
        pageUpdate(
          id: $id
          page: $page
        ) {
          page {
            id
            title
            handle
            templateSuffix
          }

          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      variables: {
        id: pageId,
        page,
      },
    },
  );

  const json = await response.json();

  if (json.errors?.length) {
    throw new Error(json.errors.map((error) => error.message).join(", "));
  }

  const result = json.data?.pageUpdate;

  if (result?.userErrors?.length) {
    throw new Error(result.userErrors.map((error) => error.message).join(", "));
  }

  return result?.page;
}

/* =========================================================
   SNAPSHOT
========================================================= */

export async function getShopifyPageSnapshot(admin, pageId) {
  const response = await admin.graphql(
    `#graphql
      query GetPageSnapshot(
        $id: ID!
      ) {
        page(id: $id) {
          id
          title
          handle
          body
          templateSuffix
          isPublished
          publishedAt

          metafields(
            first: 50
            namespace: "ymmt"
          ) {
            nodes {
              id
              namespace
              key
              type
              value
            }
          }
        }
      }
    `,
    {
      variables: {
        id: pageId,
      },
    },
  );

  const json = await response.json();

  if (json.errors?.length) {
    throw new Error(json.errors.map((error) => error.message).join(", "));
  }

  if (!json.data?.page) {
    throw new Error(`Unable to find Shopify page ${pageId}.`);
  }

  return json.data.page;
}

/* =========================================================
   RESTORE SNAPSHOT
========================================================= */

export async function restoreShopifyPageSnapshot(admin, snapshot) {
  const metafields =
    snapshot.metafields?.nodes?.map((metafield) => ({
      namespace: metafield.namespace,

      key: metafield.key,

      type: metafield.type,

      value: metafield.value,
    })) || [];

  const page = {
    title: snapshot.title,

    handle: snapshot.handle,

    body: snapshot.body || "",

    templateSuffix: snapshot.templateSuffix || "",

    isPublished: Boolean(snapshot.isPublished),
  };

  if (metafields.length > 0) {
    page.metafields = metafields;
  }

  const response = await admin.graphql(
    `#graphql
      mutation RestorePage(
        $id: ID!
        $page: PageUpdateInput!
      ) {
        pageUpdate(
          id: $id
          page: $page
        ) {
          page {
            id
            title
            handle
            templateSuffix
            isPublished
          }

          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      variables: {
        id: snapshot.id,
        page,
      },
    },
  );

  const json = await response.json();

  if (json.errors?.length) {
    throw new Error(json.errors.map((error) => error.message).join(", "));
  }

  const result = json.data?.pageUpdate;

  if (result?.userErrors?.length) {
    throw new Error(result.userErrors.map((error) => error.message).join(", "));
  }

  return result?.page;
}

/* =========================================================
   VEHICLE HELPERS
========================================================= */

function normalizeVehicleValue(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function getVehicleKey(record) {
  return [record.year, record.make, record.model, record.trim || ""]
    .map(normalizeVehicleValue)
    .join("|");
}

/*
 * Fallback matcher for older live-store pages that may not have a
 * usable ymmt.vehicle metafield.
 *
 * Example:
 *
 * 1999-honda-accord-base-luxeline-seat-covers
 *
 * matches:
 *
 * 1999-honda-accord-base
 */
function findRecordFromPageHandle(pageHandle, candidates) {
  const handle = String(pageHandle || "")
    .trim()
    .toLowerCase();

  if (!handle) {
    return null;
  }

  for (const candidate of candidates) {
    if (
      handle === candidate.vehicleHandle ||
      handle.startsWith(`${candidate.vehicleHandle}-`)
    ) {
      return candidate.record;
    }
  }

  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* =========================================================
   GRAPHQL THROTTLE RETRY
========================================================= */

async function graphqlWithThrottleRetry(
  admin,
  query,
  options,
  { maxRetries = 6, initialDelay = 1000, onThrottle = null } = {},
) {
  let attempt = 0;

  while (true) {
    const response = await admin.graphql(query, options);

    const json = await response.json();

    const throttledError = json.errors?.find(
      (error) =>
        error.extensions?.code === "THROTTLED" ||
        String(error.message || "")
          .toLowerCase()
          .includes("throttled"),
    );

    if (!throttledError) {
      return json;
    }

    if (attempt >= maxRetries) {
      throw new Error(
        `Shopify API remained throttled after ${
          maxRetries + 1
        } attempts. Please wait a moment and search again.`,
      );
    }

    const throttleStatus =
      json.extensions?.cost?.throttleStatus ||
      throttledError.extensions?.cost?.throttleStatus;

    let delay = initialDelay * Math.pow(2, attempt);

    delay = Math.min(delay, 10000);

    if (
      throttleStatus &&
      Number(throttleStatus.currentlyAvailable || 0) < 100
    ) {
      delay = Math.max(delay, 2500);
    }

    console.warn(
      `[YMMT Search] Shopify throttled request. Retry ${
        attempt + 1
      }/${maxRetries} in ${delay}ms.`,
    );

    if (typeof onThrottle === "function") {
      await onThrottle({
        attempt: attempt + 1,

        delay,

        throttleStatus,
      });
    }

    await sleep(delay);

    attempt += 1;
  }
}

/* =========================================================
   JSON SEARCH WITH LIVE PROGRESS
========================================================= */

export async function searchYMMTPagesByRecords(admin, records, options = {}) {
  const onProgress =
    typeof options.onProgress === "function"
      ? options.onProgress
      : async () => {};

  if (!records?.length) {
    return {
      pages: [],
      missingRecords: [],
    };
  }

  const wantedVehicles = new Map();

  for (const record of records) {
    wantedVehicles.set(getVehicleKey(record), record);
  }

  const wantedKeysByYear = new Map();

  for (const record of records) {
    const year = String(record.year || "").trim();

    if (!year) {
      continue;
    }

    if (!wantedKeysByYear.has(year)) {
      wantedKeysByYear.set(year, new Set());
    }

    wantedKeysByYear.get(year).add(getVehicleKey(record));
  }

  const totalYears = wantedKeysByYear.size;

  let processedYears = 0;

  let totalRequestCount = 0;

  const matchedKeys = new Set();

  const pages = [];

  const seenPageIds = new Set();

  for (const [year, wantedYearKeys] of wantedKeysByYear.entries()) {
    let cursor = null;

    let hasNextPage = true;

    let requestCount = 0;

    const foundYearKeys = new Set();

    /*
     * Build handles from the SAME rules
     * used for page creation.
     *
     * Longest handles are checked first:
     *
     * accord-base
     * before
     * accord
     *
     * This protects the Base/no-trim distinction.
     */
    const yearHandleCandidates = [];

    for (const key of wantedYearKeys) {
      const record = wantedVehicles.get(key);

      if (!record) {
        continue;
      }

      yearHandleCandidates.push({
        key,
        record,

        vehicleHandle: buildYMMTVehicleHandleBase(record),
      });
    }

    yearHandleCandidates.sort(
      (a, b) => b.vehicleHandle.length - a.vehicleHandle.length,
    );

    const MAX_REQUESTS_PER_YEAR = 60;

    console.log(
      `[YMMT JSON Search] Starting year ${year}. ${wantedYearKeys.size} vehicle(s) requested.`,
    );

    await onProgress({
      currentYear: year,

      processedYears,

      requestCount: totalRequestCount,

      currentYearTotal: wantedYearKeys.size,

      currentYearFound: 0,

      currentYearMissing: wantedYearKeys.size,

      pagesFound: pages.length,

      missingCount: records.length - matchedKeys.size,

      progress:
        totalYears > 0 ? Math.floor((processedYears / totalYears) * 100) : 0,

      message: `Searching ${year}...`,
    });

    while (hasNextPage) {
      if (requestCount >= MAX_REQUESTS_PER_YEAR) {
        await onProgress({
          currentYear: year,

          processedYears,

          requestCount: totalRequestCount,

          currentYearTotal: wantedYearKeys.size,

          currentYearFound: foundYearKeys.size,

          currentYearMissing: Math.max(
            0,

            wantedYearKeys.size - foundYearKeys.size,
          ),

          pagesFound: pages.length,

          missingCount: records.length - matchedKeys.size,

          message: `Safety limit reached for ${year}. Finishing with the pages found so far.`,
        });

        break;
      }

      requestCount += 1;

      totalRequestCount += 1;

      const json = await graphqlWithThrottleRetry(
        admin,

        `#graphql
            query SearchYMMTPagesFromJson(
              $after: String
              $query: String
            ) {
              pages(
                first: 100
                after: $after
                query: $query
              ) {
                nodes {
                  id
                  title
                  handle
                  templateSuffix
                  isPublished

                  vehicle: metafield(
                    namespace: "ymmt"
                    key: "vehicle"
                  ) {
                    value
                  }

                  productHandle: metafield(
                    namespace: "ymmt"
                    key: "product_handle"
                  ) {
                    value
                  }

                  sourceProductHandle: metafield(
                    namespace: "ymmt"
                    key: "source_product_handle"
                  ) {
                    value
                  }
                }

                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          `,

        {
          variables: {
            after: cursor,

            query: year,
          },
        },

        {
          maxRetries: 6,

          initialDelay: 1000,

          onThrottle: async ({ attempt, delay }) => {
            await onProgress({
              currentYear: year,

              processedYears,

              requestCount: totalRequestCount,

              currentYearTotal: wantedYearKeys.size,

              currentYearFound: foundYearKeys.size,

              currentYearMissing: Math.max(
                0,

                wantedYearKeys.size - foundYearKeys.size,
              ),

              pagesFound: pages.length,

              missingCount: records.length - matchedKeys.size,

              message: `Shopify throttled the request. Retrying in ${Math.round(
                delay / 1000,
              )}s (attempt ${attempt})...`,
            });
          },
        },
      );

      if (json.errors?.length) {
        throw new Error(json.errors.map((error) => error.message).join(", "));
      }

      const connection = json.data?.pages;

      if (!connection) {
        break;
      }

      for (const page of connection.nodes) {
        if (page.templateSuffix !== "product-ymmt") {
          continue;
        }

        /*
         * MATCH METHOD 1:
         * Try ymmt.vehicle metafield.
         */
        let vehicle = null;

        let originalRecord = null;

        let key = null;

        if (page.vehicle?.value) {
          try {
            const metafieldVehicle = JSON.parse(page.vehicle.value);

            const metafieldKey = getVehicleKey(metafieldVehicle);

            if (wantedYearKeys.has(metafieldKey)) {
              vehicle = metafieldVehicle;

              key = metafieldKey;

              originalRecord = wantedVehicles.get(metafieldKey) || null;
            }
          } catch {
            /*
             * Ignore bad legacy metafield JSON.
             * We will try handle matching below.
             */
          }
        }

        /*
         * MATCH METHOD 2:
         * Fall back to Shopify page handle.
         *
         * This supports older live-store pages
         * that don't have ymmt.vehicle.
         */
        if (!originalRecord) {
          const handleRecord = findRecordFromPageHandle(
            page.handle,
            yearHandleCandidates,
          );

          if (handleRecord) {
            const handleKey = getVehicleKey(handleRecord);

            if (wantedYearKeys.has(handleKey)) {
              vehicle = handleRecord;

              key = handleKey;

              originalRecord = handleRecord;
            }
          }
        }

        if (!originalRecord || !vehicle || !key) {
          continue;
        }

        matchedKeys.add(key);

        foundYearKeys.add(key);

        if (seenPageIds.has(page.id)) {
          continue;
        }

        seenPageIds.add(page.id);

        pages.push({
          id: page.id,

          title: page.title,

          handle: page.handle,

          templateSuffix: page.templateSuffix,

          isPublished: page.isPublished,

          productHandle: page.productHandle?.value || "",

          sourceProductHandle: page.sourceProductHandle?.value || "",

          year: vehicle.year || "",

          make: vehicle.make || "",

          model: vehicle.model || "",

          trim: vehicle.trim || "",

          manufacturer:
            vehicle.manufacturer || originalRecord?.manufacturer || "",

          compatibility:
            vehicle.compatible ||
            vehicle.compat ||
            originalRecord?.compatible ||
            "",

          warning: vehicle.warning || originalRecord?.warning || "",
        });
      }

      hasNextPage = Boolean(connection.pageInfo.hasNextPage);

      cursor = connection.pageInfo.endCursor;

      const estimatedYearFraction = Math.min(
        requestCount / MAX_REQUESTS_PER_YEAR,

        0.95,
      );

      const estimatedProgress =
        totalYears > 0
          ? Math.min(
              99,

              Math.floor(
                ((processedYears + estimatedYearFraction) / totalYears) * 100,
              ),
            )
          : 0;

      await onProgress({
        currentYear: year,

        processedYears,

        requestCount: totalRequestCount,

        currentYearTotal: wantedYearKeys.size,

        currentYearFound: foundYearKeys.size,

        currentYearMissing: Math.max(
          0,

          wantedYearKeys.size - foundYearKeys.size,
        ),

        pagesFound: pages.length,

        missingCount: records.length - matchedKeys.size,

        progress: estimatedProgress,

        message:
          `${year}: found ${foundYearKeys.size}/${wantedYearKeys.size} vehicle(s), ` +
          `${pages.length} Shopify page(s) matched so far.`,
      });

      if (hasNextPage) {
        await sleep(250);
      }
    }

    processedYears += 1;

    await onProgress({
      currentYear: year,

      processedYears,

      requestCount: totalRequestCount,

      currentYearTotal: wantedYearKeys.size,

      currentYearFound: foundYearKeys.size,

      currentYearMissing: Math.max(
        0,

        wantedYearKeys.size - foundYearKeys.size,
      ),

      pagesFound: pages.length,

      missingCount: records.length - matchedKeys.size,

      progress:
        totalYears > 0
          ? Math.min(
              99,

              Math.floor((processedYears / totalYears) * 100),
            )
          : 99,

      message: `Finished ${year}.`,
    });
  }

  const missingRecords = records.filter(
    (record) => !matchedKeys.has(getVehicleKey(record)),
  );

  await onProgress({
    currentYear: null,

    processedYears,

    requestCount: totalRequestCount,

    currentYearTotal: 0,

    currentYearFound: 0,

    currentYearMissing: 0,

    pagesFound: pages.length,

    missingCount: missingRecords.length,

    progress: 100,

    message: "Search completed.",
  });

  console.log(
    `[YMMT JSON Search] Complete. ${pages.length} Shopify page(s) found, ${missingRecords.length} vehicle record(s) missing.`,
  );

  return {
    pages,
    missingRecords,
  };
}

/* =========================================================
   MANUAL SEARCH WITH LIVE PROGRESS
========================================================= */

export async function searchYMMTPagesByFilters(
  admin,
  filters = {},
  options = {},
) {
  const onProgress =
    typeof options.onProgress === "function"
      ? options.onProgress
      : async () => {};

  const pages = [];
  const seenPageIds = new Set();

  const normalize = (value) =>
    String(value || "")
      .trim()
      .toLowerCase();

  const exactMatch = (value, filter) =>
    !normalize(filter) || normalize(value) === normalize(filter);

  const partialMatch = (value, filter) =>
    !normalize(filter) || normalize(value).includes(normalize(filter));

  /*
   * Shopify cannot directly search inside the ymmt.vehicle JSON metafield.
   *
   * We therefore use the strongest useful filter to reduce the Shopify
   * result set first, then apply the exact YMMT filters locally.
   *
   * Year is preferred because every YMMT page title/handle begins with
   * the vehicle year.
   */
  const scopeTerm =
    String(filters.year || "").trim() ||
    String(filters.search || "").trim() ||
    String(filters.make || "").trim() ||
    String(filters.model || "").trim() ||
    String(filters.trim || "").trim() ||
    String(filters.productHandle || "").trim();

  const shopifyQueryParts = [];

  if (scopeTerm) {
    shopifyQueryParts.push(scopeTerm);
  }

  if (filters.status === "published") {
    shopifyQueryParts.push("published_status:published");
  }

  if (filters.status === "draft") {
    shopifyQueryParts.push("published_status:unpublished");
  }

  const shopifyQuery = shopifyQueryParts.join(" AND ");

  let cursor = null;
  let hasNextPage = true;

  let requestCount = 0;
  let pagesChecked = 0;

  /*
   * Old manual search:
   *
   * 20 requests × 100 pages = 2,000 candidate pages.
   *
   * The background search can safely inspect much more while using
   * Shopify throttle retry protection.
   */
  const MAX_REQUESTS = 150;

  const filterSummary = Object.entries(filters)
    .filter(([, value]) => String(value || "").trim())
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");

  await onProgress({
    currentYear: filters.year || "All",

    processedYears: 0,

    requestCount: 0,

    currentYearTotal: 0,

    currentYearFound: 0,

    currentYearMissing: 0,

    pagesFound: 0,

    missingCount: 0,

    progress: 0,

    message: `Manual search started${
      filterSummary ? `: ${filterSummary}` : ""
    }.`,
  });

  while (hasNextPage) {
    if (requestCount >= MAX_REQUESTS) {
      await onProgress({
        currentYear: filters.year || "All",

        processedYears: 1,

        requestCount,

        currentYearTotal: pagesChecked,

        currentYearFound: pages.length,

        currentYearMissing: 0,

        pagesFound: pages.length,

        missingCount: 0,

        progress: 99,

        message:
          `Safety limit reached after ${requestCount} API requests. ` +
          `Returning ${pages.length} matching page(s).`,
      });

      break;
    }

    requestCount += 1;

    const json = await graphqlWithThrottleRetry(
      admin,

      `#graphql
        query ManualYMMTPageSearch(
          $after: String
          $query: String
        ) {
          pages(
            first: 100
            after: $after
            query: $query
          ) {
            nodes {
              id
              title
              handle
              templateSuffix
              isPublished

              vehicle: metafield(
                namespace: "ymmt"
                key: "vehicle"
              ) {
                value
              }

              productHandle: metafield(
                namespace: "ymmt"
                key: "product_handle"
              ) {
                value
              }

              sourceProductHandle: metafield(
                namespace: "ymmt"
                key: "source_product_handle"
              ) {
                value
              }
            }

            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `,

      {
        variables: {
          after: cursor,

          query: shopifyQuery || null,
        },
      },

      {
        maxRetries: 6,

        initialDelay: 1000,

        onThrottle: async ({ attempt, delay }) => {
          await onProgress({
            currentYear: filters.year || "All",

            processedYears: 0,

            requestCount,

            currentYearTotal: pagesChecked,

            currentYearFound: pages.length,

            currentYearMissing: 0,

            pagesFound: pages.length,

            missingCount: 0,

            progress: Math.min(
              95,
              Math.max(1, Math.floor((requestCount / MAX_REQUESTS) * 100)),
            ),

            message:
              `Shopify throttled manual search. ` +
              `Retrying in ${Math.round(delay / 1000)}s ` +
              `(attempt ${attempt})...`,
          });
        },
      },
    );

    if (json.errors?.length) {
      throw new Error(json.errors.map((error) => error.message).join(", "));
    }

    const connection = json.data?.pages;

    if (!connection) {
      break;
    }

    pagesChecked += connection.nodes.length;

    for (const page of connection.nodes) {
      /*
       * Only manage YMMT pages.
       */
      if (page.templateSuffix !== "product-ymmt") {
        continue;
      }

      let vehicle = {};

      try {
        vehicle = page.vehicle?.value ? JSON.parse(page.vehicle.value) : {};
      } catch {
        vehicle = {};
      }

      const pageData = {
        id: page.id,

        title: page.title,

        handle: page.handle,

        templateSuffix: page.templateSuffix,

        isPublished: page.isPublished,

        productHandle: page.productHandle?.value || "",

        sourceProductHandle: page.sourceProductHandle?.value || "",

        year: String(vehicle.year || ""),

        make: String(vehicle.make || ""),

        model: String(vehicle.model || ""),

        trim: String(vehicle.trim || ""),

        manufacturer: String(vehicle.manufacturer || ""),

        compatibility: String(vehicle.compatible || vehicle.compat || ""),

        warning: String(vehicle.warning || ""),
      };

      /*
       * Apply the exact YMMT filters.
       */
      const matches =
        partialMatch(`${pageData.title} ${pageData.handle}`, filters.search) &&
        exactMatch(pageData.year, filters.year) &&
        partialMatch(pageData.make, filters.make) &&
        partialMatch(pageData.model, filters.model) &&
        partialMatch(pageData.trim, filters.trim) &&
        partialMatch(pageData.manufacturer, filters.manufacturer) &&
        partialMatch(pageData.compatibility, filters.compatibility) &&
        partialMatch(pageData.warning, filters.warning) &&
        partialMatch(
          `${pageData.productHandle} ${pageData.sourceProductHandle}`,
          filters.productHandle,
        ) &&
        (!filters.status ||
          (filters.status === "published" && pageData.isPublished) ||
          (filters.status === "draft" && !pageData.isPublished));

      if (matches && !seenPageIds.has(page.id)) {
        seenPageIds.add(page.id);

        pages.push(pageData);
      }
    }

    hasNextPage = Boolean(connection.pageInfo.hasNextPage);

    cursor = connection.pageInfo.endCursor;

    const estimatedProgress = hasNextPage
      ? Math.min(
          95,
          Math.max(1, Math.floor((requestCount / MAX_REQUESTS) * 100)),
        )
      : 99;

    await onProgress({
      currentYear: filters.year || "All",

      processedYears: hasNextPage ? 0 : 1,

      requestCount,

      currentYearTotal: pagesChecked,

      currentYearFound: pages.length,

      currentYearMissing: 0,

      pagesFound: pages.length,

      missingCount: 0,

      progress: estimatedProgress,

      message:
        `Request ${requestCount}: checked ${pagesChecked} ` +
        `candidate page(s), found ${pages.length} ` +
        `matching YMMT page(s).`,
    });

    if (hasNextPage) {
      await sleep(250);
    }
  }

  await onProgress({
    currentYear: filters.year || "All",

    processedYears: 1,

    requestCount,

    currentYearTotal: pagesChecked,

    currentYearFound: pages.length,

    currentYearMissing: 0,

    pagesFound: pages.length,

    missingCount: 0,

    progress: 100,

    message:
      `Manual search completed. ` + `${pages.length} matching page(s) found.`,
  });

  return {
    pages,

    missingRecords: [],

    pagesChecked,
  };
}

/* =========================================================
   RECREATE DELETED PAGE
========================================================= */

export async function recreateShopifyPageFromSnapshot(admin, snapshot) {
  if (!snapshot) {
    throw new Error("Missing page snapshot.");
  }

  const metafields =
    snapshot.metafields?.nodes?.map((metafield) => ({
      namespace: metafield.namespace,

      key: metafield.key,

      type: metafield.type,

      value: metafield.value,
    })) || [];

  const page = {
    title: snapshot.title,

    handle: snapshot.handle,

    body: snapshot.body || "",

    templateSuffix: snapshot.templateSuffix || "",

    isPublished: Boolean(snapshot.isPublished),
  };

  if (metafields.length > 0) {
    page.metafields = metafields;
  }

  const response = await admin.graphql(
    `#graphql
        mutation RecreateDeletedPage(
          $page: PageCreateInput!
        ) {
          pageCreate(
            page: $page
          ) {
            page {
              id
              title
              handle
              templateSuffix
              isPublished
            }

            userErrors {
              field
              message
            }
          }
        }
      `,
    {
      variables: {
        page,
      },
    },
  );

  const json = await response.json();

  if (json.errors?.length) {
    throw new Error(json.errors.map((error) => error.message).join(", "));
  }

  const result = json.data?.pageCreate;

  if (result?.userErrors?.length) {
    throw new Error(result.userErrors.map((error) => error.message).join(", "));
  }

  if (!result?.page) {
    throw new Error("Shopify did not return the recreated page.");
  }

  return result.page;
}
