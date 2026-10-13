const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Retry only transient API failures. A retry exhaustion stops the job; it does
// not turn an unknown Shopify result into a completed/failed page checkpoint.
export async function pageUpdateGraphql(
  admin,
  document,
  variables,
  {
    budget = {},
    assertOwner = () => {},
    onEvent = async () => {},
    sleep = wait,
  } = {},
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    assertOwner();
    const pace = Math.min(
      10000,
      Math.max(0, (budget.nextAt || 0) - Date.now()),
    );
    if (pace) {
      await onEvent("wait", `Waiting ${pace} ms for Shopify capacity.`);
      await sleep(pace);
    }
    assertOwner();
    await onEvent(
      "request",
      attempt ? `Shopify retry ${attempt}/2.` : "Sending Shopify request.",
    );
    let json,
      status,
      transient = false,
      retryAfter = 0;
    try {
      const response = await admin.graphql(document, { variables });
      status = response.status || 200;
      retryAfter = Number(response.headers?.get?.("retry-after") || 0) * 1000;
      if (status === 429 || status >= 500) transient = true;
      else if (status >= 400)
        throw new Error(`Shopify returned HTTP ${status}.`);
      else json = await response.json();
    } catch (error) {
      const body = error.body;
      const errors = Array.isArray(body?.errors)
        ? body.errors
        : body?.errors?.graphQLErrors;
      if (errors?.length) json = { ...body, errors };
      else if (
        [429, 500, 502, 503, 504].includes(
          error.response?.code || error.response?.status,
        ) ||
        [
          "ECONNRESET",
          "ETIMEDOUT",
          "EAI_AGAIN",
          "UND_ERR_CONNECT_TIMEOUT",
        ].includes(error.code || error.cause?.code) ||
        /fetch failed|socket hang up/i.test(error.message)
      )
        transient = true;
      else throw error;
    }
    const cost = json?.extensions?.cost,
      capacity = cost?.throttleStatus;
    if (capacity?.restoreRate > 0)
      budget.nextAt =
        Date.now() +
        Math.ceil(
          (Math.max(
            0,
            Number(cost.requestedQueryCost || 0) - capacity.currentlyAvailable,
          ) /
            capacity.restoreRate) *
            1000,
        );
    if (json?.errors?.length) {
      transient = json.errors.every((e) =>
        ["THROTTLED", "INTERNAL_SERVER_ERROR"].includes(e.extensions?.code),
      );
      if (!transient)
        throw new Error(json.errors.map((e) => e.message).join("; "));
    }
    if (transient) {
      const definitelyThrottled =
        status === 429 ||
        json?.errors?.every((e) => e.extensions?.code === "THROTTLED");
      if (/\bmutation\b/.test(document) && !definitelyThrottled)
        throw new Error(
          "The page write returned an unknown result. The queue is paused; Resume will read the page before another write.",
        );
      if (attempt === 2)
        throw new Error(
          "Shopify is still unavailable or throttled after three attempts. The queue is paused; pending pages will be checked on Resume.",
        );
      const delay = Math.min(10000, Math.max(retryAfter, 1000 * 2 ** attempt));
      await onEvent(
        "wait",
        `Shopify is temporarily unavailable or throttled. Retry ${attempt + 1}/2 in ${delay} ms.`,
      );
      await sleep(delay);
      continue;
    }
    if (!json?.data)
      throw new Error(
        "Shopify returned no data. Resume after checking the server logs.",
      );
    assertOwner();
    return json.data;
  }
}
