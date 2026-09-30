function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeSearchValue(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

function isThrottleError(error) {
  const message = String(error?.message || "").toLowerCase();

  if (message.includes("throttled") || message.includes("throttle")) {
    return true;
  }

  const graphQLErrors =
    error?.body?.errors?.graphQLErrors ||
    error?.body?.errors?.errors ||
    error?.graphQLErrors ||
    [];

  return Array.isArray(graphQLErrors)
    ? graphQLErrors.some(
        (item) =>
          item?.extensions?.code === "THROTTLED" ||
          String(item?.message || "")
            .toLowerCase()
            .includes("throttled"),
      )
    : false;
}

async function requestWithThrottleRetry(
  admin,
  query,
  variables,
  { maxRetries = 7, initialDelay = 750 } = {},
) {
  let attempt = 0;

  while (true) {
    try {
      const response = await admin.graphql(query, {
        variables,
      });

      const json = await response.json();

      const throttled = json.errors?.some(
        (error) =>
          error?.extensions?.code === "THROTTLED" ||
          String(error?.message || "")
            .toLowerCase()
            .includes("throttled"),
      );

      if (throttled) {
        throw Object.assign(new Error("Shopify GraphQL request throttled."), {
          throttled: true,
        });
      }

      if (json.errors?.length) {
        throw new Error(json.errors.map((error) => error.message).join(", "));
      }

      return json;
    } catch (error) {
      const throttled = error?.throttled || isThrottleError(error);

      if (!throttled || attempt >= maxRetries) {
        throw error;
      }

      const delay = Math.min(initialDelay * 2 ** attempt, 10000);

      console.warn(
        `[ExistingPages] Shopify throttled targeted handle lookup. ` +
          `Retry ${attempt + 1}/${maxRetries} in ${delay}ms.`,
      );

      await sleep(delay);

      attempt += 1;
    }
  }
}

/*
 * Check ONLY the Shopify page handles that
 * the app actually cares about.
 *
 * OLD:
 * Scan every page in Shopify.
 *
 * NEW:
 * Receive candidate handles from Review/Create/Job
 * and query only those handles.
 */
export async function getExistingPageHandles(admin, candidateHandles = []) {
  const normalizedCandidates = [
    ...new Set(
      candidateHandles
        .map((handle) =>
          String(handle || "")
            .trim()
            .toLowerCase(),
        )
        .filter(Boolean),
    ),
  ];

  if (!normalizedCandidates.length) {
    return new Set();
  }

  const existingHandles = new Set();

  /*
   * 50 exact handles per Shopify request.
   *
   * Review:
   * 50 vehicles × 3 products
   * = about 3 requests instead of scanning the store.
   */
  const BATCH_SIZE = 50;

  for (
    let index = 0;
    index < normalizedCandidates.length;
    index += BATCH_SIZE
  ) {
    const batch = normalizedCandidates.slice(index, index + BATCH_SIZE);

    const searchQuery = batch
      .map((handle) => `handle:"${escapeSearchValue(handle)}"`)
      .join(" OR ");

    const json = await requestWithThrottleRetry(
      admin,

      `#graphql
          query ExistingPages(
            $query: String!
          ) {
            pages(
              first: 250
              query: $query
            ) {
              nodes {
                handle
              }
            }
          }
        `,

      {
        query: searchQuery,
      },
    );

    const pages = json.data?.pages?.nodes || [];

    for (const page of pages) {
      if (page?.handle) {
        existingHandles.add(String(page.handle).trim().toLowerCase());
      }
    }

    /*
     * Small pause protects Shopify API capacity
     * when thousands of candidates are checked.
     */
    if (index + BATCH_SIZE < normalizedCandidates.length) {
      await sleep(100);
    }
  }

  return existingHandles;
}
