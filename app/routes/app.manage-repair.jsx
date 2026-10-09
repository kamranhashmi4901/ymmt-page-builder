import { useEffect, useState } from "react";
import { Link, useFetcher, useLoaderData, useRouteError } from "react-router";
import { authenticate } from "../shopify.server";
import { createFileCorrectionJob, getFileCorrectionJob, latestFileCorrectionJob, advanceFileCorrectionJob, fileCorrectionView } from "../lib/ymmt-page-file-corrections.server";
import { repairError } from "../lib/ymmt-page-repair-storage.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request); const url = new URL(request.url);
  try { const job = url.searchParams.get("job") ? await getFileCorrectionJob(session.shop, url.searchParams.get("job")) : await latestFileCorrectionJob(session.shop); return { job: await fileCorrectionView(job, url.searchParams.get("offset")), error: "" }; }
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
      job = await createFileCorrectionJob(session.shop, await csv.text(), await json.text());
    } else if (["advance", "correct", "retry-failed"].includes(intent)) job = await advanceFileCorrectionJob(session.shop, String(form.get("job") || ""), admin, intent);
    else throw new Error("Unknown correction action.");
    return { job: await fileCorrectionView(job), error: "" };
  } catch (error) { return { error: repairError(error) }; }
};
const card = { background: "#fff", border: "1px solid #ddd", borderRadius: "12px", padding: "18px" };
const button = { padding: "10px 16px", background: "#202020", color: "#fff", border: "none", borderRadius: "8px", fontWeight: 650, cursor: "pointer", textDecoration: "none", display: "inline-block" };
const secondary = { ...button, background: "#fff", color: "#202020", border: "1px solid #ccc" };
export default function CorrectPages() {
  const loaded = useLoaderData(), worker = useFetcher(); const [auto, setAuto] = useState(false);
  const candidate = worker.data?.job;
  const job = candidate && (!loaded.job || Date.parse(candidate.updatedAt) > Date.parse(loaded.job.updatedAt)) ? candidate : loaded.job;
  const pending = worker.state !== "idle", active = ["checking", "correcting"].includes(job?.phase);
  const error = worker.data?.error || loaded.error || job?.error;
  const submit = (intent) => { setAuto(true); worker.submit({ intent, job: job.id }, { method: "post", action: "/app/manage-repair" }); };
  useEffect(() => { if (worker.data?.error || job?.status === "failed" || !active) setAuto(false); }, [worker.data, job?.status, active]);
  useEffect(() => {
    if (!auto || pending || !active || job?.status === "failed" || worker.data?.error) return;
    const timer = setTimeout(() => worker.submit({ intent: "advance", job: job.id }, { method: "post", action: "/app/manage-repair" }), 700);
    return () => clearTimeout(timer);
  }, [auto, pending, active, job?.id, job?.updatedAt, job?.status, worker.data, worker.submit]);
  return <s-page heading="Correct Pages">
    <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
      <div style={{ display: "flex", gap: "16px" }}><Link to="/app/manage">← Manage Pages</Link><Link to="/app/scan-pages">Scan Pages</Link></div>
      {error && <div role="alert" style={{ ...card, background: "#fff4f4", color: "#8a2e1b" }}>{error}</div>}
      {(!job || !active) && <div style={card}>
        <strong>1. Upload your saved files</strong>
        <p>Upload the prepared page list and corrected vehicle data. Check Pages reads only the listed page IDs. It does not change pages.</p>
        <worker.Form method="post" action="/app/manage-repair" encType="multipart/form-data" onSubmit={() => setAuto(false)}>
          <input type="hidden" name="intent" value="upload" />
          <label style={{ display: "block", marginBottom: "14px" }}>Page list: ymmt-pages-to-correct.csv<br /><input name="csv" type="file" accept=".csv,text/csv" required disabled={pending} /></label>
          <label style={{ display: "block", marginBottom: "14px" }}>Vehicle data: ymmt-affected-pages-corrected.json<br /><input name="json" type="file" accept=".json,application/json" required disabled={pending} /></label>
          <button style={button} disabled={pending} type="submit">{pending ? "Uploading…" : "Upload Files"}</button>
        </worker.Form>
      </div>}
      {job && <>
        <div style={card}>
          <strong>{job.phase === "review" ? "2. Check complete — review the differences" : job.phase === "complete" ? "3. Correction complete" : job.phase === "correcting" ? "3. Correcting fields" : "2. Check saved pages"}</strong>
          <p>{job.phase === "review" ? "Review the table below. Correct Fields applies verified values to the pages that need changes." : job.phase === "complete" ? "Updated pages were checked again. Failed, changed, and skipped pages still need review." : "Progress is saved after each batch. Keep this screen open to continue, or return later and resume."}</p>
          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
            {active && !auto && <button style={button} disabled={pending} onClick={() => submit("advance")}>{job.status === "failed" ? "Retry Current Batch" : job.phase === "checking" ? job.checked ? "Resume Check" : "Check Pages" : "Resume Corrections"}</button>}
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
