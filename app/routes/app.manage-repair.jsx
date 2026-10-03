import { useEffect, useState } from "react";
import { Link, useFetcher, useLoaderData, useRouteError } from "react-router";
import { authenticate } from "../shopify.server";
import { advanceRepairJob, createRepairJob, getRepairJob, latestRepairJob, repairView } from "../lib/ymmt-page-repair-jobs.server";
import { repairError } from "../lib/ymmt-page-repair-storage.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  try {
    const job = url.searchParams.get("job") ? await getRepairJob(session.shop, url.searchParams.get("job")) : await latestRepairJob(session.shop);
    return { job: await repairView(job, url.origin, url.searchParams.get("offset")), error: "" };
  } catch (error) { return { job: null, error: repairError(error) }; }
};
export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const form = await request.formData(); const url = new URL(request.url);
  try {
    const intent = String(form.get("intent") || "");
    const job = intent === "create" ? await createRepairJob(session.shop) : await advanceRepairJob(session.shop, String(form.get("job") || ""), admin, intent);
    return { job: await repairView(job, url.origin), error: "" };
  } catch (error) { return { error: repairError(error) }; }
};
const card = { background: "#fff", border: "1px solid #e3e3e3", borderRadius: "12px", padding: "18px" };
const button = { padding: "10px 16px", borderRadius: "8px", border: "none", background: "#303030", color: "white", fontWeight: 650, cursor: "pointer", textDecoration: "none", display: "inline-block" };
const secondary = { ...button, border: "1px solid #c9c9c9", background: "white", color: "#303030" };
const phases = ["Scan products", "Scan pages", "Review & export", "Apply corrections", "Final results"];
const stepIndex = { products: 0, products_done: 0, pages: 1, review: 2, correcting: 3, results: 4, done: 4 };

export default function ManagePageRepair() {
  const loaded = useLoaderData(); const worker = useFetcher();
  const [auto, setAuto] = useState(false);
  const candidate = worker.data?.job;
  const job = candidate && (!loaded.job || Date.parse(candidate.updatedAt) >= Date.parse(loaded.job.updatedAt)) ? candidate : loaded.job;
  const pending = worker.state !== "idle";
  const error = worker.data?.error || loaded.error || job?.error;
  const advancing = ["products", "pages", "correcting"].includes(job?.phase);
  const send = (intent, run = false) => {
    setAuto(run);
    worker.submit({ intent, job: job?.id || "" }, { method: "post", action: "/app/manage-repair" });
  };
  useEffect(() => {
    if (worker.data?.error || job?.status === "failed") setAuto(false);
  }, [worker.data, job?.status]);
  useEffect(() => {
    if (!auto || pending || !advancing || worker.data?.error || job?.status === "failed") return;
    const timer = setTimeout(() => worker.submit({ intent: "advance", job: job.id }, { method: "post", action: "/app/manage-repair" }), 700);
    return () => clearTimeout(timer);
  }, [auto, pending, advancing, job?.id, job?.updatedAt, job?.status, worker.data, worker.submit]);

  const step = job ? stepIndex[job.phase] : 0;
  return <s-page heading="Update missing values in all pages">
    <style>{`.ymmt-repair-table { width:100%; border-collapse:collapse; font-size:13px; } .ymmt-repair-table th,.ymmt-repair-table td { padding:12px; border-bottom:1px solid #e3e3e3; text-align:left; vertical-align:top; }`}</style>
    <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
      <Link to="/app/manage" style={{ color: "#303030" }}>← Manage Pages</Link>
      <div style={{ ...card, display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: "8px" }}>
        {phases.map((label, index) => <div key={label} style={{ padding: "10px", borderRadius: "8px", background: index === step ? "#303030" : "#f4f4f4", color: index === step ? "white" : "#616161" }}>{index + 1}. {label}</div>)}
      </div>
      {error && <div role="alert" style={{ ...card, color: "#8a2e1b", background: "#fff4f4" }}>{error}</div>}
      {!job && <div style={card}><strong>Scan first, then review corrections</strong><p>Scan the product catalog and all Shopify pages. YMMT pages are checked for product links, required vehicle details, compatibility, and supported vehicle data in the page body.</p><p>Scans leave Shopify unchanged. Missing values are filled only when a verified source is available.</p><button disabled={pending || Boolean(loaded.error)} style={button} onClick={() => send("create", true)}>{pending ? "Preparing…" : "Start product scan"}</button></div>}
      {job && <>
        <div style={card}>
          <strong aria-live="polite">{job.phase === "done" ? "Session finalized" : phases[step]}</strong>
          {job.endedEarly && <p role="alert">This session ended before completion. Its report is partial. Start a new scan to continue auditing all pages.</p>}
          {job.phase === "done" && !job.repairProcessed && job.affectedPages > 0 && <p>No corrections were applied in this session. Affected pages remain listed in the report.</p>}
          <p style={{ color: "#616161" }}>{pending ? "Processing a bounded batch. Waiting and retry messages appear in the log when the batch returns." : job.phase === "products_done" ? "Product scan complete. Start the page scan when ready." : job.phase === "review" ? "Review affected pages and download the audit before applying corrections." : job.phase === "results" ? "Correction pass complete. Review results, export the CSV, and finalize." : auto ? "Continuing automatically through saved batches…" : "Paused. Progress is saved in R2."}</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "10px" }}>
            {advancing && !auto && <button disabled={pending} style={button} onClick={() => send("advance", true)}>{job.status === "failed" ? "Retry current batch" : "Resume"}</button>}
            {auto && advancing && <button style={secondary} onClick={() => setAuto(false)}>Pause after this batch</button>}
            {job.phase === "products_done" && <button disabled={pending} style={button} onClick={() => send("pages", true)}>Start page scan</button>}
            {job.reportUrl && <a href={job.reportUrl} target="_blank" rel="noreferrer" style={secondary}>Export pages and results CSV</a>}
            {job.phase === "review" && job.repairablePages > 0 && <button disabled={pending} style={button} onClick={() => send("correct", true)}>Apply verified corrections · {job.repairablePages.toLocaleString()} pages</button>}
            {job.phase === "results" && job.counts.failed > 0 && <button disabled={pending} style={button} onClick={() => send("retry-failed", true)}>Retry failed pages · {job.counts.failed}</button>}
            {(["review", "results"].includes(job.phase) || job.status === "failed") && <button disabled={pending} style={secondary} onClick={() => send("finalize")}>{job.status === "failed" ? "End session" : "Finalize session"}</button>}
            {job.phase === "done" && <button disabled={pending} style={button} onClick={() => send("create", true)}>Start a new scan</button>}
          </div>
          <p style={{ fontSize: "12px", color: "#616161" }}>Keep this page open to continue automatic batches. If you close it or Railway restarts, return and click Resume. An interrupted batch lock can take up to three minutes to expire.</p>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: "10px" }}>
          {[["Products scanned", job.productsScanned], ["Pages scanned", job.pagesScanned], ["YMMT pages", job.ymmtPages], ["Already complete", job.completePages], ["Affected pages", job.affectedPages], ["Pages with verified fixes", job.repairablePages], ["API requests", job.requestCount]].map(([label, value]) => <div style={card} key={label}><div style={{ color: "#616161", fontSize: "12px" }}>{label}</div><strong style={{ display: "block", marginTop: "8px", fontSize: "24px" }}>{value.toLocaleString()}</strong></div>)}
        </div>
        {["correcting", "results", "done"].includes(job.phase) && <div style={card}>
          <strong>Correction results · {job.repairProcessed.toLocaleString()} / {job.affectedPages.toLocaleString()} affected pages checked</strong>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "18px", marginTop: "12px" }}>{Object.entries(job.counts).map(([label, count]) => <span key={label}>{label}: <strong>{count.toLocaleString()}</strong></span>)}</div>
          <p style={{ color: "#616161", fontSize: "13px" }}>Partial pages have verified fixes applied but still need review. Changed pages were skipped because their data changed after scanning. Unchanged pages were already complete before correction.</p>
        </div>}
        {job.rows.length > 0 && <div style={card}>
          <strong>Affected pages · {job.offset + 1}–{job.offset + job.rows.length} of {job.affectedPages}</strong>
          <div style={{ overflowX: "auto", marginTop: "10px" }}><table className="ymmt-repair-table"><thead><tr><th>Page</th><th>Missing / invalid values</th><th>Verified proposal</th><th>Status / review</th></tr></thead><tbody>
            {job.rows.map((row) => <tr key={row.id}><td><a href={row.url} target="_blank" rel="noreferrer">{row.handle}</a><br/><a href={row.adminUrl} target="_blank" rel="noreferrer">Open in Shopify</a></td><td>{row.issues.join(", ")}</td><td>{row.fields.length ? row.fields.join(", ") : "No verified fix"}{row.proposedProduct && <div>Product: {row.proposedProduct}</div>}</td><td>{row.result ? `${row.result.status}: ${row.result.message}` : row.unresolved.join(" ") || "Ready for correction"}</td></tr>)}
          </tbody></table></div>
          <div style={{ display: "flex", gap: "12px", marginTop: "14px" }}>
            {job.offset > 0 && <Link style={secondary} to={`/app/manage-repair?job=${job.id}&offset=${Math.max(0, job.offset - 25)}`} onClick={() => setAuto(false)}>Previous</Link>}
            {job.offset + job.rows.length < job.affectedPages && <Link style={secondary} to={`/app/manage-repair?job=${job.id}&offset=${job.offset + 25}`} onClick={() => setAuto(false)}>Next</Link>}
          </div>
        </div>}
        <div style={card}><strong>Activity log</strong><div role="log" aria-live="polite" style={{ marginTop: "12px", maxHeight: "320px", overflow: "auto", background: "#f6f6f7", padding: "12px", borderRadius: "8px", fontFamily: "monospace", fontSize: "12px" }}>{[...job.logs].reverse().map((log, index) => <div key={`${log.time}-${index}`} style={{ marginBottom: "8px", color: log.level === "error" ? "#8a2e1b" : "#303030" }}>[{log.time}] [{log.level}] {log.message}</div>)}</div></div>
      </>}
    </div>
  </s-page>;
}
export function ErrorBoundary() {
  const error = useRouteError();
  return <s-page heading="Page repair"><s-section><p role="alert">Unable to open the repair screen. Reopen the app from Shopify Admin.</p><p>{error instanceof Error ? error.message : "Check the server logs if this continues."}</p><Link to="/app/manage">Back to Manage Pages</Link></s-section></s-page>;
}
