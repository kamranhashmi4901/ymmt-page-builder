const BATCH_SIZE = 25;
const MAX_RETRIES = 7;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeSearchValue(value) {
  return String(value || "").trim().replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function isThrottleError(error) {
  const errors = error?.body?.errors?.graphQLErrors || error?.body?.errors?.errors || error?.graphQLErrors || [];
  return error?.throttled || [error?.status, error?.response?.status, error?.body?.errors?.networkStatusCode].some((status) => Number(status) === 429) || /throttl/i.test(String(error?.message || "")) ||
    (Array.isArray(errors) && errors.some((item) => item?.extensions?.code === "THROTTLED" || /throttl/i.test(String(item?.message || ""))));
}

function rememberCost(budget, cost) {
  const throttle = cost?.throttleStatus;
  if (!throttle || !Number.isFinite(Number(throttle.currentlyAvailable)) || !Number.isFinite(Number(throttle.restoreRate))) return;
  budget.available = Number(throttle.currentlyAvailable);
  budget.restoreRate = Number(throttle.restoreRate);
  budget.requested = Number(cost.requestedQueryCost) || BATCH_SIZE + 2;
  budget.at = Date.now();
}

function capacityWait(budget) {
  if (!budget.at || budget.restoreRate <= 0) return 0;
  const available = budget.available + ((Date.now() - budget.at) / 1000) * budget.restoreRate;
  return Math.max(0, Math.ceil(((budget.requested + 5 - available) / budget.restoreRate) * 1000));
}

async function requestWithThrottleRetry(admin, query, variables, budget, options) {
  const maxRetries = options.maxRetries ?? MAX_RETRIES;
  budget.startedAt ??= Date.now();
  const remaining = () => (options.maxDurationMs ?? Infinity) - (Date.now() - budget.startedAt);
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const wait = capacityWait(budget);
    if (wait >= remaining() || wait > (options.maxWaitMs ?? Infinity)) throw new Error("Shopify needs a longer wait. Progress is saved; retry the duplicate check shortly.");
    if (wait > 0) {
      console.info(`[ExistingPages] Waiting ${wait}ms for Shopify lookup capacity.`);
      await options.onEvent?.("wait", `Waiting ${Math.ceil(wait / 1000)} seconds for Shopify API capacity.`);
      await sleep(wait);
    }
    try {
      budget.requests = (budget.requests || 0) + 1;
      if (budget.requests > (options.maxRequests ?? Infinity)) throw new Error("This lookup needs too many response pages for one short batch. Narrow the vehicle/product selection and retry.");
      await options.onEvent?.("request", "Checking existing Shopify page handles.");
      const timeoutMs = Math.min(options.requestTimeoutMs ?? Infinity, remaining());
      if (timeoutMs <= 0) throw new Error("This lookup reached its short batch time limit. Retry to continue checking.");
      let timer;
      let response;
      try {
        const request = admin.graphql(query, { variables });
        response = Number.isFinite(timeoutMs) ? await Promise.race([request, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Shopify lookup took too long. Progress is saved; retry this batch.")), timeoutMs); })]) : await request;
      } finally { if (timer) clearTimeout(timer); }
      const json = await response.json();
      rememberCost(budget, json.extensions?.cost);
      const errors = Array.isArray(json.errors) ? json.errors : [];
      if (response.status === 429 || errors.some((error) => error?.extensions?.code === "THROTTLED" || /throttl/i.test(String(error?.message || "")))) {
        const retryAfter = Number(response.headers?.get?.("retry-after"));
        throw Object.assign(new Error("Shopify GraphQL lookup throttled."), {
          throttled: true,
          retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0,
        });
      }
      if (errors.length) throw new Error(errors.map((error) => error.message).join(", "));
      if (response.ok === false) throw new Error(`Shopify page lookup failed (HTTP ${response.status}).`);
      return json;
    } catch (error) {
      rememberCost(budget, error?.body?.extensions?.cost || error?.extensions?.cost);
      if (!isThrottleError(error)) throw error;
      if (attempt === maxRetries) {
        throw new Error("The duplicate-page check could not finish because Shopify is busy. Pause other scan/update jobs and try Review again. Duplicate results have not been assumed.");
      }
      const delay = Math.max(capacityWait(budget), Number(error.retryAfterMs) || 0, Math.min(750 * 2 ** attempt, 10000));
      console.warn(`[ExistingPages] Shopify throttled targeted handle lookup. Retry ${attempt + 1}/${maxRetries} in ${delay}ms.`);
      if (delay >= remaining() || delay > (options.maxWaitMs ?? Infinity)) throw new Error("Shopify needs a longer wait. Progress is saved; retry the duplicate check shortly.");
      await options.onEvent?.("throttle", `Shopify throttled this lookup. Retry ${attempt + 1}/${maxRetries} in ${Math.ceil(delay / 1000)} seconds.`);
      await sleep(delay);
    }
  }
  throw new Error("The Shopify duplicate-page check did not finish.");
}

const LOOKUP = `#graphql
  query ExistingPages($query: String!, $first: Int!, $after: String) {
    pages(first: $first, after: $after, query: $query) {
      nodes { handle }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// Shared by Review, selection and creation. Read-only; incomplete lookups throw.
export async function getExistingPageHandles(admin, candidateHandles = [], options = {}) {
  const candidates = [...new Set(candidateHandles.map((handle) => String(handle || "").trim().toLowerCase()).filter(Boolean))];
  const existingHandles = new Set();
  const budget = {};
  if (!candidates.length) return existingHandles;
  console.info(`[ExistingPages] Checking ${candidates.length} candidate handles in batches of ${BATCH_SIZE}.`);
  await options.onEvent?.("info", `Checking ${candidates.length} candidate handles in batches of ${BATCH_SIZE}.`);
  for (let index = 0; index < candidates.length; index += BATCH_SIZE) {
    const batch = candidates.slice(index, index + BATCH_SIZE);
    const wanted = new Set(batch);
    const searchQuery = batch.map((handle) => `handle:"${escapeSearchValue(handle)}"`).join(" OR ");
    let after = null;
    const cursors = new Set();
    let hasNext = true;
    while (hasNext) {
      const json = await requestWithThrottleRetry(admin, LOOKUP, { query: searchQuery, first: batch.length, after }, budget, options);
      const pages = json.data?.pages;
      if (!Array.isArray(pages?.nodes) || typeof pages.pageInfo?.hasNextPage !== "boolean") {
        throw new Error("Shopify returned an incomplete duplicate-page lookup. Try Review again; duplicate checking was not skipped.");
      }
      for (const page of pages.nodes) {
        const handle = String(page?.handle || "").trim().toLowerCase();
        if (wanted.has(handle)) existingHandles.add(handle);
      }
      // Searching can return additional matches. Follow cursors so smaller reads
      // never silently miss an existing candidate on another response page.
      if (batch.every((handle) => existingHandles.has(handle))) break;
      hasNext = pages.pageInfo.hasNextPage;
      if (hasNext) {
        const cursor = pages.pageInfo.endCursor;
        if (!cursor || cursors.has(cursor)) throw new Error("Shopify duplicate-page pagination did not advance. Try Review again.");
        cursors.add(cursor);
        after = cursor;
      }
    }
    console.info(`[ExistingPages] Checked ${Math.min(index + BATCH_SIZE, candidates.length)}/${candidates.length} candidate handles; ${existingHandles.size} existing pages found.`);
    await options.onEvent?.("progress", `Checked ${Math.min(index + BATCH_SIZE, candidates.length)}/${candidates.length} candidate handles; ${existingHandles.size} duplicates found.`);
    if (index + BATCH_SIZE < candidates.length && !budget.at) await sleep(150);
  }
  return existingHandles;
}
