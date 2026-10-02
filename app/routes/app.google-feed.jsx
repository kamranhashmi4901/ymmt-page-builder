import { useEffect, useState } from "react";
import { isRouteErrorResponse, useActionData, useFetcher, useLoaderData, useNavigation, useRouteError, Form } from "react-router";
import { authenticate } from "../shopify.server";
import { createFeedJob, feedJobView, feedStorageRoot, getFeedJob, getLatestFeedJob, queueFeedRetry, startFeedJob } from "../lib/google-feed-jobs.server";

const YEARS = Array.from({ length: 32 }, (_, index) => String(1996 + index));
const ACTIVE = new Set(["queued", "building", "validating", "compressing"]);

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  try {
    feedStorageRoot();
    // These reads inspect saved export metadata only, never Shopify page counts.
    const id = url.searchParams.get("job");
    const job = id ? await getFeedJob(session.shop, id) : await getLatestFeedJob(session.shop);
    if (job && ACTIVE.has(job.status)) {
      // Resume a previously requested export after the old worker lease expires.
      startFeedJob(session.shop, job.id, admin);
    }
    return { shop: session.shop, job: feedJobView(job, url.origin), storageError: "" };
  } catch (error) {
    console.error("Google feed status error:", error);
    return { shop: session.shop, job: null, storageError: error.message || "Export storage is unavailable." };
  }
};

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const form = await request.formData();
  const url = new URL(request.url);
  try {
    if (form.get("intent") === "retry") {
      const job = await queueFeedRetry(session.shop, String(form.get("jobId") || ""));
      startFeedJob(session.shop, job.id, admin, { retry: true });
      return { job: feedJobView(job, url.origin) };
    }
    const selected = String(form.get("year") || "");
    if (selected !== "all" && !YEARS.includes(selected)) return { error: "Select a year from 1996 to 2027, or All years." };
    const job = await createFeedJob(session.shop, selected === "all" ? "" : selected);
    startFeedJob(session.shop, job.id, admin);
    return { job: feedJobView(job, url.origin) };
  } catch (error) {
    console.error("Google feed create error:", error);
    return { error: error.message || "Unable to start the export." };
  }
};

const button = { display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "10px 16px", borderRadius: "8px", border: "none", background: "#303030", color: "#fff", fontWeight: 650, cursor: "pointer", textDecoration: "none" };
const secondary = { ...button, background: "#fff", color: "#303030", border: "1px solid #c9c9c9" };
const card = { background: "#fff", border: "1px solid #e3e3e3", borderRadius: "12px", padding: "16px" };
const bytes = (value) => `${((value || 0) / 1024 / 1024).toFixed(1)} MB`;

export default function GoogleFeed() {
  const { shop, job: savedJob, storageError } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const statusFetcher = useFetcher();
  const baseJob = actionData?.job || savedJob;
  const polledJob = statusFetcher.data?.job;
  const hasNewerStatus = Boolean(
    polledJob && baseJob && polledJob.id === baseJob.id &&
    Date.parse(polledJob.updatedAt) >= Date.parse(baseJob.updatedAt)
  );
  const current = hasNewerStatus ? polledJob : baseJob;
  const [year, setYear] = useState(savedJob ? savedJob.year || "all" : "");
  const busy = Boolean(current && ACTIVE.has(current.status));
  const submitting = navigation.state !== "idle";
  const statusError = statusFetcher.data?.storageError;

  useEffect(() => {
    if (!baseJob?.id || !busy || statusFetcher.state !== "idle") return;
    const timer = setTimeout(() => {
      statusFetcher.load(`/app/google-feed?job=${encodeURIComponent(baseJob.id)}`);
    }, 2500);
    return () => clearTimeout(timer);
  }, [baseJob?.id, busy, statusFetcher.state, statusFetcher.data, statusFetcher.load]);

  const titles = { queued: "Export queued", building: "Creating XML feed", validating: "Checking the completed XML", compressing: "Preparing the compressed download", ready: "Your feed is ready", failed: "Export needs attention" };
  return (
    <s-page heading="Google Feed">
      <style>{`@keyframes ymmt-feed-progress { from { transform: translateX(-100%); } to { transform: translateX(350%); } } @media (prefers-reduced-motion: reduce) { .ymmt-feed-progress { animation: none !important; } }`}</style>
      <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
        <s-section>
          <Form method="post" style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "12px" }}>
            <strong>Create XML Feed</strong>
            <label htmlFor="feed-year">Select year</label>
            <select id="feed-year" name="year" value={year} onChange={(event) => setYear(event.target.value)} disabled={busy || submitting} required style={{ padding: "10px 12px", minWidth: "240px", maxWidth: "100%", borderRadius: "8px", border: "1px solid #c9c9c9", background: "#fff" }}>
              <option value="" disabled>Select a year</option>
              {YEARS.map((value) => <option key={value} value={value}>{value}</option>)}
              <option value="all">All years — complete feed</option>
            </select>
            <div style={{ color: "#616161", fontSize: "13px", lineHeight: 1.5 }}>
              Create a feed for one year or all years. Searching starts when you click Create XML Feed.
            </div>
            <button type="submit" disabled={!year || busy || submitting || Boolean(storageError)} style={{ ...button, opacity: !year || busy || submitting || storageError ? 0.5 : 1 }}>
              {submitting ? "Starting…" : busy ? "Export in progress…" : "Create XML Feed"}
            </button>
            <div style={{ color: "#616161", fontSize: "12px", wordBreak: "break-word" }}>{shop}</div>
          </Form>
        </s-section>

        {(storageError || actionData?.error || statusError) && <div role="alert" style={{ ...card, background: "#fff4f4", color: "#8a2e1b", borderColor: "#f1b8b8" }}>{storageError || actionData?.error || statusError}</div>}

        {current && (
          <s-section>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
              <strong aria-live="polite">{titles[current.status] || current.status}</strong>
              <span style={{ padding: "5px 10px", borderRadius: "999px", background: current.status === "ready" ? "#eaf8ec" : "#f4f4f4", color: "#303030", fontSize: "12px" }}>{current.year || "All years"}</span>
            </div>
            {busy && (
              <>
                <div role="progressbar" aria-label="Feed export is in progress" style={{ marginTop: "16px", height: "6px", borderRadius: "8px", background: "#e3e3e3", overflow: "hidden" }}>
                  <div className="ymmt-feed-progress" style={{ width: "30%", height: "100%", background: "#303030", borderRadius: "8px", animation: "ymmt-feed-progress 2s linear infinite" }} />
                </div>
                <p style={{ color: "#616161", fontSize: "13px", lineHeight: 1.5 }}>The export runs in the background. You can leave this page and return to download it when ready.</p>
              </>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "12px", marginTop: "16px" }}>
              {[["Pages checked", current.pagesChecked], ["Pages included", current.pagesIncluded], ["Variant offers", current.offers], ["XML size", bytes(current.bytes)]].map(([label, value]) => (
                <div key={label} style={card}><div style={{ color: "#616161", fontSize: "12px" }}>{label}</div><strong style={{ display: "block", marginTop: "6px", fontSize: "24px" }}>{typeof value === "number" ? value.toLocaleString() : value}</strong></div>
              ))}
            </div>
            {current.status === "failed" && (
              <div role="alert" style={{ marginTop: "16px", ...card, background: "#fff4f4", borderColor: "#f1b8b8" }}>
                <p style={{ marginTop: 0 }}>{current.error}</p>
                <p style={{ color: "#616161", fontSize: "13px" }}>Progress is saved after each batch. Correct the issue, then retry. The unfinished batch may be processed again.</p>
                <Form method="post"><input type="hidden" name="intent" value="retry" /><input type="hidden" name="jobId" value={current.id} /><button type="submit" disabled={submitting} style={button}>Retry export</button></Form>
              </div>
            )}
            {current.status === "ready" && current.gzipUrl && (
              <div style={{ marginTop: "16px", ...card, background: "#f1fff2", borderColor: "#b7ddb9" }}>
                <strong>Completed XML checked successfully</strong>
                <p style={{ color: "#616161", fontSize: "13px", lineHeight: 1.5 }}>Download the compressed file for a smaller transfer, or choose the original XML. Both use the same completed export. You can retry either download without recreating the feed.</p>
                <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
                  <a href={current.gzipUrl} target="_blank" rel="noreferrer" style={button}>Download XML.GZ · {bytes(current.gzipBytes)}</a>
                  <a href={current.xmlUrl} target="_blank" rel="noreferrer" style={secondary}>Download XML · {bytes(current.bytes)}</a>
                </div>
              </div>
            )}
          </s-section>
        )}
      </div>
    </s-page>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = isRouteErrorResponse(error) ? error.status : null;
  return <s-page heading="Google Feed"><s-section><div role="alert"><strong>Unable to open Google Feed{status ? ` (${status})` : ""}.</strong><p>Reopen the app from Shopify Admin. If this continues, check the server logs.</p><button type="button" style={button} onClick={() => window.location.reload()}>Reload</button></div></s-section></s-page>;
}
