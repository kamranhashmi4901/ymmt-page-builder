import { useEffect, useRef, useState } from "react";
import { Link, useFetcher, useLoaderData, useRouteError, useSearchParams } from "react-router";
import { authenticate } from "../shopify.server";
import { advancePageUpdateJob, controlPageUpdateJob, pageUpdateView } from "../lib/page-update-jobs.server";
import { pageUpdateCsv } from "../lib/page-update-csv.server";

export const loader = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  return { job: await pageUpdateView(session.shop, params.sessionId, 0, { includeRows: false }), start: url.searchParams.get("start") === "1" };
};
export const action = async ({ request, params }) => {
  const { session, admin } = await authenticate.admin(request);
  const form = await request.formData(), intent = String(form.get("intent") || "");
  try {
    if (intent === "csv") return { csv: await pageUpdateCsv(session.shop, params.sessionId), fileName: `ymmt-updated-pages-${params.sessionId}.csv`, downloadId: crypto.randomUUID(), pageUpdateAction: true };
    if (intent === "advance") await advancePageUpdateJob(session.shop, params.sessionId, admin);
    else await controlPageUpdateJob(session.shop, params.sessionId, intent);
    return { job: await pageUpdateView(session.shop, params.sessionId, 0, { includeRows: false }), error: "", pageUpdateAction: true };
  } catch (error) {
    return { error: error instanceof Response ? "This job is not available for the current store." : error.message || "The batch could not finish. Its saved checkpoint is retained.", pageUpdateAction: true };
  }
};
export const shouldRevalidate = ({ actionResult, defaultShouldRevalidate }) => actionResult?.pageUpdateAction ? false : defaultShouldRevalidate;
const button = { padding: "10px 16px", borderRadius: "8px", border: "1px solid #bbb", cursor: "pointer", background: "#222", color: "white" };
const card = { padding: "16px", border: "1px solid #ddd", borderRadius: "10px", marginBottom: "16px" };
export default function PageUpdate() {
  const loaded = useLoaderData(), worker = useFetcher(), control = useFetcher(), poller = useFetcher(), exporter = useFetcher();
  const [auto, setAuto] = useState(false), [, setParams] = useSearchParams();
  const started = useRef(""), downloaded = useRef("");
  let job = loaded.job;
  for (const candidate of [worker.data?.job, control.data?.job, poller.data?.job]) if (candidate?.id === job.id && candidate.offset === job.offset && (candidate.revision > job.revision || (candidate.revision === job.revision && candidate.fetchedAt >= job.fetchedAt))) job = candidate;
  const workerPending = worker.state !== "idle", controlPending = control.state !== "idle";
  const error = worker.data?.error || control.data?.error || exporter.data?.error;
  const { submit: submitWorker } = worker, { submit: submitControl } = control, { load: loadPoll, state: pollState } = poller;
  useEffect(() => {
    if (!loaded.start || started.current === loaded.job.id) return;
    started.current = loaded.job.id; setAuto(true);
    submitControl({ intent: "resume", offset: String(loaded.job.offset) }, { method: "post" });
  }, [loaded.start, loaded.job.id, loaded.job.offset, submitControl]);
  useEffect(() => {
    if (!loaded.start || control.data?.job?.id !== loaded.job.id || control.data.job.status !== "running") return;
    setParams((previous) => { const next = new URLSearchParams(previous); next.delete("start"); return next; }, { replace: true });
  }, [loaded.start, loaded.job.id, control.data, setParams]);
  const id = job.id, offset = job.offset, running = job.status === "running", busy = job.busy, position = job.processed;
  useEffect(() => {
    if ((!running && !busy && !workerPending) || pollState !== "idle") return;
    const timer = setTimeout(() => loadPoll(`/app/page-update/${id}?state=1&offset=${offset}`), 2500);
    return () => clearTimeout(timer);
  }, [running, busy, workerPending, pollState, poller.data, id, offset, loadPoll]);
  useEffect(() => {
    if (!auto || !running || busy || workerPending || controlPending) return;
    const timer = setTimeout(() => submitWorker({ intent: "advance", offset: String(offset) }, { method: "post" }), 400);
    return () => clearTimeout(timer);
  }, [auto, running, busy, workerPending, controlPending, position, worker.data, control.data, offset, submitWorker]);
  useEffect(() => { if (worker.data?.error || worker.data?.job?.status === "paused") setAuto(false); }, [worker.data]);
  useEffect(() => { if (control.data?.error) setAuto(false); }, [control.data]);
  useEffect(() => {
    const data = exporter.data;
    if (!data?.csv || downloaded.current === data.downloadId) return;
    downloaded.current = data.downloadId;
    const url = URL.createObjectURL(new Blob([data.csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = data.fileName; document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [exporter.data]);
  const send = (intent) => { setAuto(intent !== "pause"); submitControl({ intent, offset: String(offset) }, { method: "post" }); };
  const back = job.searchJobId ? `/app/manage?searchJobId=${job.searchJobId}` : "/app/manage";
  return <s-page heading="Page Update Progress">
    <p><Link to={back}>← Return to saved search</Link> · <Link to="/app/page-updates">All update jobs</Link>{!job.busy && job.status !== "running" && job.updated > 0 && !job.rolledBackAt ? <> · <Link to={`/app/manage?sessionId=${job.id}&sessionMode=rollback`}>Review rollback options</Link></> : null}</p>
    {error && <div role="alert" style={{ ...card, background: "#fff0ef" }}>{error}</div>}
    <div style={card}>
      <strong>Status: {job.status.replaceAll("_", " ")}</strong><p>Job: <code>{job.id}</code></p>
      <progress max={job.total || 1} value={job.processed} style={{ width: "100%", height: "18px" }} />
      <p>{job.processed.toLocaleString()} / {job.total.toLocaleString()} checked ({job.progress}%). Updated: {job.updated} · Already correct: {job.unchanged} · Failed: {job.failed} · Remaining: {job.remaining}</p>
      <p role="status">{job.message}</p>
      <p>Last saved activity: {new Date(job.lastActivity).toLocaleString()} · Shopify requests: {job.apiRequests}</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "10px" }}>
        {job.resumable && job.remaining > 0 && (auto || busy ? <button type="button" style={button} disabled={controlPending} onClick={() => send("pause")}>Pause new updates</button> : <button type="button" style={button} disabled={controlPending || workerPending} onClick={() => send("resume")}>Play / Resume</button>)}
        {job.resumable && job.failed > 0 && !busy && !workerPending && <button type="button" style={button} disabled={controlPending} onClick={() => send("retry-failed")}>Retry Failed Pages ({job.failed})</button>}
        <button type="button" style={button} disabled={pollState !== "idle"} onClick={() => loadPoll(`/app/page-update/${id}?state=1&offset=${offset}`)}>Refresh progress</button>
        {job.updated > 0 && <button type="button" style={button} disabled={exporter.state !== "idle"} onClick={() => exporter.submit({ intent: "csv" }, { method: "post" })}>{exporter.state === "idle" ? "Download Updated Pages CSV" : "Preparing CSV…"}</button>}
      </div>
      {busy && <p>A batch is in progress. Already-submitted pages finish verification before Pause takes effect.</p>}
      {!auto && job.resumable && job.remaining > 0 && !busy && <p>The queue is saved. Press Play / Resume to process the remaining pages. Keep this screen open while running.</p>}
      {!job.resumable && <p>This older session has no saved queue. Its results remain available; start a new update from the saved JSON search to check remaining pages.</p>}
      {job.failed > 0 && <p role="alert">This job has pages needing review. Failed pages are not counted as successful updates.</p>}
    </div>
    <div role="log" aria-live="polite" style={{ ...card, background: "#080808", color: "#eee", maxHeight: "420px", overflow: "auto", fontFamily: "monospace", fontSize: "12px", lineHeight: 1.8 }}>
      {!job.logs.length && <div>No activity logs have been recorded for this job yet.</div>}
      {[...job.logs].reverse().map((entry, i) => <div key={`${entry.time}-${i}`} style={{ color: entry.level === "error" ? "#ff9b9b" : entry.level === "success" ? "#9ee6b1" : "#eee" }}>[{new Date(entry.time).toLocaleTimeString()}] {entry.message}</div>)}
    </div>
  </s-page>;
}
export function ErrorBoundary() {
  const error = useRouteError();
  return <s-page heading="Page Update Progress"><p role="alert">{error?.status === 404 ? "This job was not found for this store. Check that the persistent database is connected." : "The progress screen could not load. The saved queue is not restarted by this error; check Railway logs and reopen the job."}</p><Link to="/app/page-updates">Open update job history</Link></s-page>;
}
