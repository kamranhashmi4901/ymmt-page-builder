import { useEffect, useState } from "react";
import { Link, useFetcher, useLoaderData, useRouteError } from "react-router";
import { authenticate } from "../shopify.server";
import { createFileCorrectionJob, getFileCorrectionJob, latestFileCorrectionJob, advanceFileCorrectionJob, fileCorrectionView, fileCorrectionStatus, fileCorrectionUploadStatus } from "../lib/ymmt-page-file-corrections.server";
import { repairError } from "../lib/ymmt-page-repair-storage.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request); const url = new URL(request.url);
  try {
    const job = url.searchParams.get("job") ? await getFileCorrectionJob(session.shop, url.searchParams.get("job")) : await latestFileCorrectionJob(session.shop);
    const status = await fileCorrectionStatus(session.shop, job);
    const upload = await fileCorrectionUploadStatus(session.shop);
    const busy = Boolean(status?.busy || upload.busy);
    if (url.searchParams.get("status") === "1") return { job: status, busy, lockUntil: upload.lockUntil, error: "" };
    return { job: job ? { ...await fileCorrectionView(job, url.searchParams.get("offset")), ...status } : null, busy, lockUntil: upload.lockUntil, error: "" };
  }
  catch (error) { return { job: null, error: repairError(error) }; }
};
export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  try {
    if (Number(request.headers.get("content-length") || 0) > 64 * 1024 * 1024) throw new Error("Uploads must total less than 64 MB.");
    const form = await request.formData(); const intent = String(form.get("intent") || ""); let job;
    if (intent === "upload") {
      const csv = form.get("csv"), json = form.get("json");
      if (!csv || !json || typeof csv.text !== "function" || typeof json.text !== "function") throw new Error("Choose the prepared CSV and corrected JSON files.");
      if (csv.size > 40 * 1024 * 1024 || json.size > 20 * 1024 * 1024) throw new Error("CSV limit: 40 MB. JSON limit: 20 MB.");
      console.info("[YMMT upload] Accepted files", { shop: session.shop, csvBytes: csv.size, jsonBytes: json.size });
      job = await createFileCorrectionJob(session.shop, await csv.text(), await json.text());
      console.info("[YMMT upload] Saved job", { job: job.id, phase: job.phase, pages: job.total });
    } else if (["advance", "correct", "retry-failed"].includes(intent)) job = await advanceFileCorrectionJob(session.shop, String(form.get("job") || ""), admin, intent);
    else throw new Error("Unknown correction action.");
    return { job: await fileCorrectionView(job), error: "" };
  } catch (error) {
    const message = repairError(error);
    console.warn("[YMMT file job] Request did not complete", { shop: session.shop, message });
    if (/batch is already running|Another request updated this job/i.test(message)) {
      const job = await latestFileCorrectionJob(session.shop);
      return { job: await fileCorrectionView(job), error: "", busy: true };
    }
    return { error: message };
  }
};
const card = { background: "#fff", border: "1px solid #ddd", borderRadius: "12px", padding: "18px" };
const button = { padding: "10px 16px", background: "#202020", color: "#fff", border: "none", borderRadius: "8px", fontWeight: 650, cursor: "pointer", textDecoration: "none", display: "inline-block" };
const secondary = { ...button, background: "#fff", color: "#202020", border: "1px solid #ccc" };
export default function CorrectPages() {
  const loaded = useLoaderData(), worker = useFetcher(), poller = useFetcher(); const [auto, setAuto] = useState(false);
  const [uploadAttempted, setUploadAttempted] = useState(false);
  const candidate = worker.data?.job;
  const baseJob = candidate && (!loaded.job || Date.parse(candidate.updatedAt) > Date.parse(loaded.job.updatedAt)) ? candidate : loaded.job;
  const polled = poller.data?.job;
  const job = polled && (!baseJob || Date.parse(polled.updatedAt) >= Date.parse(baseJob.updatedAt)) ? { ...baseJob, ...polled, rows: baseJob?.id === polled.id ? baseJob.rows : [], offset: baseJob?.id === polled.id ? baseJob.offset : 0, issueCount: polled.needsCorrection + polled.skipped } : baseJob;
  const pending = worker.state !== "idle", active = ["checking", "correcting"].includes(job?.phase);
  const busy = Boolean(poller.data?.busy ?? (job?.busy || worker.data?.busy || loaded.busy));
  const error = worker.data?.error || poller.data?.error || loaded.error || job?.error;
  const submit = (intent) => { setAuto(true); worker.submit({ intent, job: job.id }, { method: "post", action: "/app/manage-repair" }); };
  useEffect(() => {
    if (!pending && !active && !busy && job?.phase !== "uploading") return;
    const timer = setTimeout(() => { if (poller.state === "idle") poller.load(`/app/manage-repair?status=1${job?.id && !pending ? `&job=${job.id}` : ""}`); }, 2500);
    return () => clearTimeout(timer);
  }, [pending, active, busy, job?.id, job?.phase, poller.state, poller.data, poller.load]);
  useEffect(() => { if (worker.data?.error || job?.status === "failed" || !active) setAuto(false); }, [worker.data, job?.status, active]);
  useEffect(() => {
    if (!auto || pending || busy || !active || job?.status === "failed" || worker.data?.error) return;
    const timer = setTimeout(() => worker.submit({ intent: "advance", job: job.id }, { method: "post", action: "/app/manage-repair" }), 700);
    return () => clearTimeout(timer);
  }, [auto, pending, busy, active, job?.id, job?.updatedAt, job?.status, worker.data, worker.submit]);
  return <s-page heading="Correct Pages">
    <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
      <div style={{ display: "flex", gap: "16px" }}><Link to="/app/manage">← Manage Pages</Link><Link to="/app/scan-pages">Scan Pages</Link></div>
      {error && <div role="alert" style={{ ...card, background: "#fff4f4", color: "#8a2e1b" }}>{error}</div>}
      {busy && !job && <div style={card} role="status"><strong>Waiting for an earlier upload request</strong><p>An upload lock is active, but no saved page list is available yet. Status refreshes automatically. Do not upload again while this request is running.</p><div style={{ background: "#080808", color: "#eee", padding: "16px", borderRadius: "8px", fontFamily: "monospace" }}>[WAITING] Checking upload status every 2.5 seconds. If the earlier request was interrupted, its lock expires automatically.</div></div>}
      {!pending && !busy && uploadAttempted && !job && !error && <div role="alert" style={card}>The upload did not return a saved job. Check the server logs for “[YMMT upload]” or “[YMMT file job]”.<button type="button" style={secondary} onClick={() => poller.load("/app/manage-repair?status=1")}>Refresh upload status</button></div>}
      {(!job || (!active && job.phase !== "uploading")) && <div style={card}>
        <strong>1. Upload your saved files</strong>
        <p>Upload the prepared page list and corrected vehicle data. Check Pages reads only the listed page IDs. It does not change pages.</p>
        <worker.Form method="post" action="/app/manage-repair" encType="multipart/form-data" onSubmit={() => { setAuto(false); setUploadAttempted(true); }}>
          <input type="hidden" name="intent" value="upload" />
          <label style={{ display: "block", marginBottom: "14px" }}>Page list: ymmt-pages-to-correct.csv<br /><input name="csv" type="file" accept=".csv,text/csv" required disabled={pending || busy} /></label>
          <label style={{ display: "block", marginBottom: "14px" }}>Vehicle data: ymmt-affected-pages-corrected.json<br /><input name="json" type="file" accept=".json,application/json" required disabled={pending || busy} /></label>
          <button style={button} disabled={pending || busy} type="submit">{pending ? "Uploading…" : busy ? "Waiting for earlier upload…" : "Upload Files"}</button>
        </worker.Form>
      </div>}
      {job && <>
        <div style={card}>
          <strong>{job.phase === "uploading" ? "1. Saving uploaded page list" : job.phase === "review" ? "2. Check complete — review the differences" : job.phase === "complete" ? "3. Correction complete" : job.phase === "correcting" ? "3. Correcting fields" : "2. Check saved pages"}</strong>
          {job.phase === "uploading" && <p>Saved {(job.uploaded || 0).toLocaleString()} / {job.total.toLocaleString()} page IDs. Logs refresh automatically.</p>}
          {busy && <p role="status">A request is running. Progress and logs refresh automatically; no need to upload again.</p>}
          <p>{job.phase === "review" ? "Review the table below. Correct Fields applies verified values to the pages that need changes." : job.phase === "complete" ? "Updated pages were checked again. Failed, changed, and skipped pages still need review." : "Progress is saved after each batch. Keep this screen open to continue, or return later and resume."}</p>
          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
            {active && !auto && <button style={button} disabled={pending || busy} onClick={() => submit("advance")}>{job.status === "failed" ? "Retry Current Batch" : job.phase === "checking" ? job.checked ? "Resume Check" : "Check Pages" : "Resume Corrections"}</button>}
            {active && auto && <button style={secondary} onClick={() => setAuto(false)}>Pause after this batch</button>}
            {job.phase === "review" && job.needsCorrection > 0 && <button style={button} disabled={pending} onClick={() => submit("correct")}>Correct Fields ({job.needsCorrection.toLocaleString()} pages)</button>}
            {job.phase === "complete" && job.failed > 0 && <button style={button} disabled={pending} onClick={() => submit("retry-failed")}>Retry Failed Pages ({job.failed.toLocaleString()})</button>}
          </div>
          {pending && <p role="status">Processing this batch…</p>}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(145px,1fr))", gap: "10px" }}>{[["Listed pages", job.total], ["Checked", job.checked], ["Need correction", job.needsCorrection], ["Already correct", job.correct], ["Manual review", job.skipped], ["Corrected", job.corrected], ["Already fixed", job.unchanged], ["Changed since check", job.changed], ["Failed", job.failed]].map(([label, value]) => <div key={label} style={card}><div>{label}</div><strong style={{ fontSize: "24px" }}>{value.toLocaleString()}</strong></div>)}</div>
        <div style={card}><strong>Logs</strong><div role="log" aria-live="polite" style={{ background: "#080808", color: "#eee", borderRadius: "8px", padding: "16px", marginTop: "12px", maxHeight: "340px", overflow: "auto", fontFamily: "monospace", fontSize: "12px", lineHeight: 1.7 }}>{[...job.logs].reverse().map((entry, i) => <div key={`${entry.time}-${i}`} style={{ color: entry.level === "error" ? "#ff9b9b" : entry.level === "success" ? "#9ee6b1" : "#eee" }}>[{entry.time}] {entry.message}</div>)}</div></div>
        {job.rows.length > 0 && <div style={card}><strong>Pages with differences or review notes</strong>
          <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}><thead><tr><th align="left">Page</th><th align="left">Differences</th><th align="left">Status</th></tr></thead><tbody>{job.rows.map((row) => <tr key={row.id} style={{ borderTop: "1px solid #ddd" }}><td style={{ padding: "12px", verticalAlign: "top" }}><a href={row.adminUrl} target="_blank" rel="noreferrer">{row.handle}</a></td><td style={{ padding: "12px" }}><details><summary>{row.issues.join(", ") || "Vehicle script requires correction"}</summary>{row.differences?.map((d, i) => <div key={i} style={{ marginTop: "6px" }}><strong>{d.field}</strong>: {String(d.current) || "(empty)"} → {String(d.expected) || "(no trim)"}</div>)}</details></td><td style={{ padding: "12px", verticalAlign: "top" }}>{row.result || row.state}{row.message && <p>{row.message}</p>}</td></tr>)}</tbody></table></div>
          <div style={{ display: "flex", gap: "10px", marginTop: "12px" }}>{job.offset > 0 && <Link style={secondary} onClick={() => setAuto(false)} to={`/app/manage-repair?job=${job.id}&offset=${Math.max(0, job.offset - 25)}`}>Previous</Link>}{job.offset + job.rows.length < job.issueCount && <Link style={secondary} onClick={() => setAuto(false)} to={`/app/manage-repair?job=${job.id}&offset=${job.offset + 25}`}>Next</Link>}</div>
        </div>}
      </>}
    </div>
  </s-page>;
}
export function ErrorBoundary() {
  const error = useRouteError();
  return <s-page heading="Correct Pages"><s-section><p role="alert">{error instanceof Error ? error.message : "Reopen the app from Shopify Admin."}</p><Link to="/app/scan-pages">Back to Scan Pages</Link></s-section></s-page>;
}
