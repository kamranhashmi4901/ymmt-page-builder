import { useEffect, useState } from "react";
import { Link, useFetcher, useLoaderData, useRouteError } from "react-router";
import { authenticate } from "../shopify.server";
import { createScanJob, advanceScanJob, getScanJob, latestScanJob, scanView } from "../lib/ymmt-page-scan-jobs.server";
import { repairError } from "../lib/ymmt-page-repair-storage.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  try {
    const job = url.searchParams.get("job") ? await getScanJob(session.shop, url.searchParams.get("job")) : await latestScanJob(session.shop);
    return { job: await scanView(job, url.origin, url.searchParams.get("offset")), error: "" };
  } catch (error) { return { job: null, error: repairError(error) }; }
};
export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const form = await request.formData(); const url = new URL(request.url);
  try {
    const intent = String(form.get("intent") || "");
    if (!["create", "advance"].includes(intent)) return { error: "This screen only scans pages. Page changes are not supported." };
    const job = intent === "create" ? await createScanJob(session.shop) : await advanceScanJob(session.shop, String(form.get("job") || ""), admin);
    return { job: await scanView(job, url.origin), error: "" };
  } catch (error) { return { error: repairError(error) }; }
};
const card = { background: "#fff", border: "1px solid #e3e3e3", borderRadius: "12px", padding: "18px" };
const button = { padding: "10px 16px", borderRadius: "8px", border: "none", background: "#202020", color: "white", fontWeight: 650, cursor: "pointer", textDecoration: "none", display: "inline-block" };
const secondary = { ...button, border: "1px solid #c9c9c9", background: "white", color: "#303030" };
export default function ScanPages() {
  const loaded = useLoaderData(); const worker = useFetcher();
  const [auto, setAuto] = useState(false);
  const candidate = worker.data?.job;
  const job = candidate && (!loaded.job || Date.parse(candidate.updatedAt) >= Date.parse(loaded.job.updatedAt)) ? candidate : loaded.job;
  const pending = worker.state !== "idle";
  const error = worker.data?.error || loaded.error || job?.error;
  const active = Boolean(job && job.status !== "complete");
  const send = (intent) => {
    setAuto(true);
    worker.submit({ intent, job: job?.id || "" }, { method: "post", action: "/app/scan-pages" });
  };
  useEffect(() => { if (worker.data?.error || job?.status === "failed") setAuto(false); }, [worker.data, job?.status]);
  useEffect(() => {
    if (!auto || pending || !active || job?.status === "failed" || worker.data?.error) return;
    const timer = setTimeout(() => worker.submit({ intent: "advance", job: job.id }, { method: "post", action: "/app/scan-pages" }), 700);
    return () => clearTimeout(timer);
  }, [auto, pending, active, job?.id, job?.updatedAt, job?.status, worker.data, worker.submit]);
  return <s-page heading="Scan Pages">
    <style>{`.ymmt-scan-table {width:100%;border-collapse:collapse;font-size:13px} .ymmt-scan-table th,.ymmt-scan-table td {padding:12px;border-bottom:1px solid #e3e3e3;text-align:left;vertical-align:top} .ymmt-scan-log {background:#080808;color:#eee;border:1px solid #282828;border-radius:10px;padding:16px;max-height:380px;overflow:auto;font-family:monospace;font-size:12px;line-height:1.65;overflow-wrap:anywhere}`}</style>
    <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
      <Link to="/app/manage" style={{ color: "#303030" }}>← Manage Pages</Link>
      {error && <div role="alert" style={{ ...card, color: "#8a2e1b", background: "#fff4f4" }}>{error}</div>}
      <div style={card}>
        <strong>{!job ? "Scan for missing or incorrect page values" : job.status === "complete" ? "Scan complete" : job.status === "preparing" ? "Preparing exports" : job.status === "failed" ? "Scan needs attention" : "Page scan"}</strong>
        <p>Checks YMMT page metadata and embedded vehicle data. Only pages with issues appear below. This scan leaves Shopify pages unchanged.</p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "10px" }}>
          {(!job || job.status === "complete") && <button style={button} disabled={pending || Boolean(loaded.error)} onClick={() => send("create")}>{pending ? "Preparing…" : job ? "Scan again" : "Start page scan"}</button>}
          {active && !auto && <button style={button} disabled={pending} onClick={() => send("advance")}>{job.status === "failed" ? "Retry scan" : "Resume scan"}</button>}
          {active && auto && <button style={secondary} onClick={() => setAuto(false)}>Pause after this batch</button>}
          {job?.csvUrl && <a style={secondary} href={job.csvUrl} target="_blank" rel="noreferrer">Download CSV</a>}
          {job?.jsonUrl && <a style={secondary} href={job.jsonUrl} target="_blank" rel="noreferrer">Export JSON</a>}
        </div>
        <p style={{ fontSize: "12px", color: "#616161" }}>{pending ? "Processing a batch. Logs update when it returns." : auto && active ? "Scanning automatically…" : active ? "Paused; progress is saved." : "Exports become available after the scan finishes."} Keep this screen open to continue; return and resume after closing it.</p>
        <p style={{ fontSize: "12px", color: "#616161" }}>Product handles are checked for presence and format. This page-only scan does not check whether an existing product still exists.</p>
      </div>
      {job && <>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(145px,1fr))", gap: "10px" }}>
          {[["Pages checked", job.pagesScanned], ["YMMT pages", job.ymmtPages], ["Metadata complete", job.completePages], ["Pages with issues", job.affectedPages]].map(([label, value]) => <div key={label} style={card}><div style={{ fontSize: "12px", color: "#616161" }}>{label}</div><strong style={{ display: "block", fontSize: "24px", marginTop: "8px" }}>{value.toLocaleString()}</strong></div>)}
        </div>
        <div style={card}>
          <strong>Scan log</strong>
          <div className="ymmt-scan-log" role="log" aria-live="polite" style={{ marginTop: "12px" }}>{[...job.logs].reverse().map((log, index) => <div key={`${log.time}-${index}`} style={{ marginBottom: "6px", color: log.level === "error" ? "#ff9b9b" : log.level === "warning" || log.level === "throttle" ? "#ffd479" : log.level === "success" ? "#9ee6b1" : "#eee" }}>[{log.time}] [{log.level.toUpperCase()}] {log.message}</div>)}</div>
        </div>
        {job.status === "complete" && <p style={{ color: "#616161", margin: 0 }}>CSV includes all {job.affectedPages.toLocaleString()} affected pages. JSON includes {job.jsonVehicles.toLocaleString()} unique vehicles.{job.jsonSkippedPages > 0 && ` ${job.jsonSkippedPages} pages cannot be represented in the sample JSON structure and remain in CSV.`}{job.jsonConflictFields > 0 && ` ${job.jsonConflictFields} conflicting JSON fields are blank; see CSV for original values.`}</p>}
        {job.rows.length > 0 ? <div style={card}>
          <strong>Pages with missing or incorrect values · {job.offset + 1}–{job.offset + job.rows.length} of {job.affectedPages}</strong>
          <div style={{ overflowX: "auto", marginTop: "12px" }}><table className="ymmt-scan-table"><thead><tr><th>Page</th><th>Missing / incorrect values</th><th>Details</th></tr></thead><tbody>{job.rows.map((row) => <tr key={row.id}><td><a href={row.url} target="_blank" rel="noreferrer">{row.title || row.handle}</a><div style={{ fontSize: "12px", color: "#616161", marginTop: "4px" }}>{row.handle}</div><a href={row.adminUrl} target="_blank" rel="noreferrer">Open in Shopify</a></td><td>{row.issues.join(", ")}</td><td>{row.unresolved.join(" ") || "Missing values detected in the page data."}</td></tr>)}</tbody></table></div>
          <div style={{ display: "flex", gap: "10px", marginTop: "14px" }}>{job.offset > 0 && <Link style={secondary} onClick={() => setAuto(false)} to={`/app/scan-pages?job=${job.id}&offset=${Math.max(0, job.offset - 25)}`}>Previous</Link>}{job.offset + job.rows.length < job.affectedPages && <Link style={secondary} onClick={() => setAuto(false)} to={`/app/scan-pages?job=${job.id}&offset=${job.offset + 25}`}>Next</Link>}</div>
        </div> : job.status === "complete" && <div style={card}>No missing or incorrect values were found by this scan.</div>}
      </>}
    </div>
  </s-page>;
}
export function ErrorBoundary() {
  const error = useRouteError();
  return <s-page heading="Scan Pages"><s-section><p role="alert">Unable to open Scan Pages. Reopen the app from Shopify Admin.</p><p>{error instanceof Error ? error.message : "Check the server logs if this continues."}</p><Link to="/app/manage">Back to Manage Pages</Link></s-section></s-page>;
}
