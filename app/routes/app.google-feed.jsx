import { useCallback, useEffect, useRef, useState } from "react";
import {
  Form,
  isRouteErrorResponse,
  useActionData,
  useFetcher,
  useLoaderData,
  useNavigation,
  useRouteError,
} from "react-router";
import { authenticate } from "../shopify.server";

// Fetch one bounded batch; never scan the whole store during navigation.
const PAGE_QUERY = `#graphql
  query FeedPages($after: String) {
    pages(first: 100, after: $after) {
      nodes {
        id title handle isPublished templateSuffix
        vehicle: metafield(namespace: "ymmt", key: "vehicle") { value }
        productHandle: metafield(namespace: "ymmt", key: "product_handle") { value }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

function parseVehicle(value) {
  try {
    const vehicle = JSON.parse(value || "{}");
    return vehicle && typeof vehicle === "object" && !Array.isArray(vehicle)
      ? vehicle
      : {};
  } catch {
    return {};
  }
}

function pageYear(page) {
  const vehicle = parseVehicle(page.vehicle?.value);
  const year = String(vehicle.year ?? vehicle.Year ?? "").trim();
  if (/^\d{4}$/.test(year)) return year;
  // Older pages may only store the year at the start of their handle.
  return page.handle?.match(/^(\d{4})(?:-|$)/)?.[1] || "";
}

function throttleDelay(json, attempt) {
  const cost = json?.extensions?.cost;
  const status = cost?.throttleStatus;
  const seconds =
    status?.restoreRate > 0
      ? Math.max(
          0,
          (cost.requestedQueryCost - status.currentlyAvailable) /
            status.restoreRate,
        )
      : 0;
  return Math.min(
    5000,
    Math.max(1000 * (attempt + 1), Math.ceil(seconds * 1000) + 250),
  );
}

async function getPageBatch(admin, after = null) {
  for (let attempt = 0; attempt < 5; attempt++) {
    let json;
    try {
      const response = await admin.graphql(PAGE_QUERY, {
        variables: { after },
      });
      json = await response.json();
      if (response.status === 429 && !json.errors?.length) {
        json.errors = [
          {
            message: "Shopify is busy. Please try again.",
            extensions: { code: "THROTTLED" },
          },
        ];
      }
    } catch (error) {
      // Shopify's SDK can throw GraphqlQueryError before response.json().
      const body = error.body;
      const errors = Array.isArray(body?.errors)
        ? body.errors
        : body?.errors?.graphQLErrors;
      if (errors?.length) json = { ...body, errors };
      else if (error.response?.code === 429 || error.response?.status === 429) {
        json = {
          errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
        };
      } else throw error;
    }
    if (json.errors?.length) {
      const throttled = json.errors.every(
        (error) => error.extensions?.code === "THROTTLED",
      );
      if (throttled && attempt < 4) {
        await new Promise((resolve) =>
          setTimeout(resolve, throttleDelay(json, attempt)),
        );
        continue;
      }
      throw new Error(json.errors.map((error) => error.message).join(", "));
    }
    const connection = json.data?.pages;
    if (!Array.isArray(connection?.nodes) || !connection.pageInfo) {
      throw new Error("Shopify did not return a valid pages response.");
    }
    if (
      connection.pageInfo.hasNextPage &&
      (!connection.pageInfo.endCursor ||
        connection.pageInfo.endCursor === after)
    ) {
      throw new Error("Shopify returned an invalid pagination cursor.");
    }
    return connection;
  }
}

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const url = new URL(request.url);

  if (url.searchParams.get("_feedSummary") === "1") {
    const after = url.searchParams.get("after") || null;
    const scan = url.searchParams.get("scan") || "";
    try {
      const connection = await getPageBatch(admin, after);
      const pages = connection.nodes.filter(
        (page) => page.templateSuffix === "product-ymmt",
      );
      return {
        scan,
        batchKey: after || "START",
        scanned: connection.nodes.length,
        totalPages: pages.length,
        publishedCount: pages.filter((page) => page.isPublished).length,
        years: [
          ...new Set(
            pages
              .filter((page) => page.isPublished)
              .map(pageYear)
              .filter(Boolean),
          ),
        ],
        hasNextPage: connection.pageInfo.hasNextPage,
        nextCursor: connection.pageInfo.endCursor,
      };
    } catch (error) {
      console.error("Google feed summary error:", error);
      return {
        scan,
        error:
          "Unable to load page statistics. Check the server logs, then retry. You can still prepare a feed link.",
      };
    }
  }

  // Authentication only: opening this route does not query Shopify pages.
  url.searchParams.set("_feedSummary", "1");
  url.searchParams.delete("after");
  url.searchParams.delete("scan");
  return { shop: session.shop, summaryUrl: `${url.pathname}${url.search}` };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const year = String(form.get("year") || "").trim();
  if (year && !/^\d{4}$/.test(year)) {
    return {
      success: false,
      error: "Choose All years or enter a four-digit year.",
    };
  }
  const url = new URL("/google-feed.xml", request.url);
  url.searchParams.set("shop", session.shop);
  if (year) url.searchParams.set("year", year);
  return { success: true, feedUrl: url.toString(), year };
};

const initialSummary = {
  totalPages: 0,
  publishedCount: 0,
  scanned: 0,
  years: [],
  complete: false,
  error: "",
};
const buttonStyle = {
  padding: "10px 16px",
  borderRadius: "8px",
  border: "none",
  background: "#303030",
  color: "#fff",
  fontWeight: 650,
  cursor: "pointer",
};
const cardStyle = {
  background: "#fff",
  border: "1px solid #e3e3e3",
  borderRadius: "12px",
  padding: "16px",
};

export default function GoogleFeed() {
  const { shop, summaryUrl } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const { load, data, state } = useFetcher();
  const [summary, setSummary] = useState(initialSummary);
  const [year, setYear] = useState("");
  const [manualYear, setManualYear] = useState("");
  const scanRef = useRef(0);
  const processedRef = useRef(new Set());
  const startedRef = useRef("");
  const generating = navigation.state !== "idle";

  const loadBatch = useCallback(
    (after, scan) => {
      const url = new URL(summaryUrl, window.location.origin);
      url.searchParams.set("scan", String(scan));
      if (after) url.searchParams.set("after", after);
      else url.searchParams.delete("after");
      load(`${url.pathname}${url.search}`);
    },
    [load, summaryUrl],
  );

  const refresh = useCallback(() => {
    scanRef.current += 1;
    processedRef.current = new Set();
    setSummary({ ...initialSummary, years: [] });
    loadBatch(null, scanRef.current);
  }, [loadBatch]);

  useEffect(() => {
    if (startedRef.current === shop) return;
    startedRef.current = shop;
    refresh();
  }, [shop, refresh]);

  useEffect(() => {
    if (state !== "idle" || !data || data.scan !== String(scanRef.current))
      return;
    if (data.error) {
      setSummary((previous) => ({ ...previous, error: data.error }));
      return;
    }
    if (processedRef.current.has(data.batchKey)) return;
    processedRef.current.add(data.batchKey);
    setSummary((previous) => ({
      totalPages: previous.totalPages + data.totalPages,
      publishedCount: previous.publishedCount + data.publishedCount,
      scanned: previous.scanned + data.scanned,
      years: [...new Set([...previous.years, ...data.years])].sort(
        (a, b) => Number(b) - Number(a),
      ),
      complete: !data.hasNextPage,
      error: "",
    }));
    if (data.hasNextPage) loadBatch(data.nextCursor, scanRef.current);
  }, [data, state, loadBatch]);

  return (
    <s-page heading="Google Feed">
      <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
        <s-section>
          <strong>Google Merchant XML Feed</strong>
          <s-paragraph>
            Download product variants from published YMMT pages for one year or
            all years.
          </s-paragraph>
        </s-section>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: "12px",
          }}
        >
          {[
            ["YMMT Pages", summary.totalPages],
            ["Published", summary.publishedCount],
            ["Store", shop],
          ].map(([label, value]) => (
            <div key={label} style={cardStyle}>
              <div style={{ color: "#616161", fontSize: "13px" }}>{label}</div>
              <div
                style={{
                  fontSize: label === "Store" ? "16px" : "26px",
                  fontWeight: 700,
                  marginTop: "6px",
                  wordBreak: "break-word",
                }}
              >
                {label !== "Store" && !summary.complete && summary.scanned === 0
                  ? "…"
                  : value}
              </div>
            </div>
          ))}
        </div>

        <div
          aria-live="polite"
          style={{
            fontSize: "13px",
            color: summary.error ? "#b42318" : "#616161",
          }}
        >
          {summary.error ||
            (summary.complete
              ? "Page statistics are up to date."
              : `Loading statistics in the background… ${summary.scanned} Shopify pages checked. Counts are provisional until complete.`)}
          <button
            type="button"
            disabled={state !== "idle"}
            onClick={refresh}
            style={{ marginLeft: "12px" }}
          >
            {summary.error ? "Retry" : "Refresh statistics"}
          </button>
        </div>

        <s-section>
          <Form
            method="post"
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              gap: "12px",
            }}
          >
            <strong>Prepare XML Feed</strong>
            <label htmlFor="feed-year">Year</label>
            <select
              id="feed-year"
              value={year}
              onChange={(event) => setYear(event.target.value)}
              style={{
                padding: "10px",
                minWidth: "220px",
                borderRadius: "8px",
                border: "1px solid #ccc",
              }}
            >
              <option value="">All years — complete XML feed</option>
              {summary.years.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
              <option value="custom">Enter a year…</option>
            </select>
            {year === "custom" && (
              <div>
                <label htmlFor="manual-year">Enter year </label>
                <input
                  id="manual-year"
                  value={manualYear}
                  onChange={(event) => setManualYear(event.target.value)}
                  inputMode="numeric"
                  pattern="[0-9]{4}"
                  maxLength={4}
                  required
                  placeholder="2027"
                  style={{ padding: "8px", width: "100px" }}
                />
              </div>
            )}
            <input
              type="hidden"
              name="year"
              value={year === "custom" ? manualYear : year}
            />
            <div style={{ color: "#616161", fontSize: "13px" }}>
              Each product variant linked to a published product-ymmt page
              becomes a separate feed item. Available years appear as statistics
              load; you can also enter a year directly.
            </div>
            <button
              type="submit"
              disabled={generating}
              style={{ ...buttonStyle, opacity: generating ? 0.6 : 1 }}
            >
              {generating ? "Preparing…" : "Prepare download link"}
            </button>
            {actionData?.error && (
              <div role="alert" style={{ color: "#b42318" }}>
                {actionData.error}
              </div>
            )}
          </Form>
        </s-section>

        {actionData?.success && (
          <s-section>
            <div
              style={{
                ...cardStyle,
                background: "#f1fff2",
                borderColor: "#b7ddb9",
              }}
            >
              <strong>
                Download link ready — {actionData.year || "all years"}
              </strong>
              <p>
                The XML is built when you open this link. Large stores may take
                longer to finish downloading.
              </p>
              <a
                href={actionData.feedUrl}
                target="_blank"
                rel="noreferrer"
                style={{
                  ...buttonStyle,
                  display: "inline-block",
                  textDecoration: "none",
                }}
              >
                Download {actionData.year ? `${actionData.year} ` : "Complete "}
                XML Feed
              </a>
              <div
                style={{
                  marginTop: "12px",
                  wordBreak: "break-all",
                  fontSize: "12px",
                }}
              >
                <code>{actionData.feedUrl}</code>
              </div>
            </div>
          </s-section>
        )}
      </div>
    </s-page>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = isRouteErrorResponse(error) ? error.status : null;
  return (
    <s-page heading="Google Feed">
      <s-section>
        <div role="alert">
          <strong>
            Unable to open Google Feed{status ? ` (${status})` : ""}.
          </strong>
          <p>
            Reopen the app from Shopify Admin. If this continues, check Railway
            logs for this request.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={buttonStyle}
          >
            Reload
          </button>
        </div>
      </s-section>
    </s-page>
  );
}
