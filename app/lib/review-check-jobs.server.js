import { createHash, randomUUID } from "node:crypto";
import db from "../db.server";
import { estimateRemainingSeconds } from "./progress-eta";
import { getExistingPageHandles } from "./shopify-pages.server";

const KIND = "review-check-v1";
const LEASE_MS = 180000;
const message = (plan, level, text) => {
  plan.revision = (plan.revision || 0) + 1;
  plan.updatedAt = new Date().toISOString();
  plan.logs = [...(plan.logs || []), { time: plan.updatedAt, level, message: text }].slice(-80);
};
const parse = (row) => {
  try { const plan = JSON.parse(row?.filterSnapshot || "{}"); return plan.kind === KIND ? plan : null; } catch { return null; }
};
async function root(shop, id) {
  const row = await db.pageActionSession.findFirst({ where: { shop, id, actionType: "review-check" } });
  if (!row || !parse(row)) throw new Response("Review check not found for this store.", { status: 404 });
  return row;
}
async function edit(shop, id, mutate) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const row = await root(shop, id), plan = parse(row);
    const fields = mutate(row, plan);
    if (fields === null) return row;
    const result = await db.pageActionSession.updateMany({ where: { id, shop, filterSnapshot: row.filterSnapshot, status: row.status }, data: { ...fields, filterSnapshot: JSON.stringify(plan) } });
    if (result.count) return { ...row, ...fields, filterSnapshot: JSON.stringify(plan) };
  }
  throw new Error("Review progress is busy. Try again shortly.");
}
export async function prepareReviewCheck(shop, uploadId, handles, existingId = "") {
  const candidates = [...new Set(handles.map((handle) => String(handle || "").trim().toLowerCase()).filter(Boolean))].sort();
  const scope = createHash("sha256").update(JSON.stringify([uploadId, candidates])).digest("hex");
  if (existingId) {
    const row = await db.pageActionSession.findFirst({ where: { shop, id: existingId, actionType: "review-check" } });
    const plan = parse(row);
    if (plan?.scope === scope && (row.status !== "completed" || Date.now() - Date.parse(plan.updatedAt) < 300000)) return row;
  }
  const plan = { kind: KIND, uploadId, scope, candidates, found: [], position: 0, activeMs: 0, logs: [], revision: 0, requests: 0, lease: null, error: "" };
  message(plan, "info", `Preparing duplicate check for ${candidates.length} proposed page handles. Shopify pages will not be changed.`);
  if (!candidates.length) message(plan, "success", "No candidate handles to check.");
  return db.pageActionSession.create({ data: { id: `rc_${randomUUID()}`, shop, actionType: "review-check", status: candidates.length ? "running" : "completed", totalPages: candidates.length, filterSnapshot: JSON.stringify(plan), ...(candidates.length ? {} : { completedAt: new Date() }) } });
}
export function reviewCheckResult(row) {
  if (row.status !== "completed") throw new Error("Duplicate checking is not complete.");
  return new Set(parse(row).found);
}
export function reviewCheckView(row) {
  const plan = parse(row);
  return { estimatedSeconds: estimateRemainingSeconds({ processed: plan.position, total: row.totalPages, elapsedMs: plan.activeMs || 0 }), id: row.id, status: row.status, total: row.totalPages, checked: plan.position, duplicates: plan.found.length, progress: row.totalPages ? Math.floor(plan.position / row.totalPages * 100) : 100, requests: plan.requests, logs: plan.logs, error: plan.error, busy: Boolean(plan.lease?.until > Date.now()), revision: plan.revision, fetchedAt: Date.now() };
}
export async function getReviewCheck(shop, id) { return reviewCheckView(await root(shop, id)); }
export async function advanceReviewCheck(shop, id, admin, retry = false) {
  const owner = randomUUID();
  const claimed = await edit(shop, id, (row, plan) => {
    if (row.status === "completed" || plan.lease?.until > Date.now() || (row.status === "failed" && !retry)) return null;
    plan.error = ""; plan.lease = { owner, until: Date.now() + LEASE_MS, startedAt: Date.now() };
    message(plan, "info", `Reading handles ${plan.position + 1}–${Math.min(plan.position + 25, plan.candidates.length)} of ${plan.candidates.length}.`);
    return { status: "running" };
  });
  const plan = parse(claimed);
  if (plan.lease?.owner !== owner) return reviewCheckView(claimed);
  const own = (state) => { if (state.lease?.owner !== owner || state.lease.until <= Date.now()) throw new Error("Review check ownership expired. Retry this batch."); };
  try {
    const found = await getExistingPageHandles(admin, plan.candidates.slice(plan.position, plan.position + 25), {
      maxRetries: 2, maxRequests: 6, maxDurationMs: 45000, requestTimeoutMs: 20000, maxWaitMs: 10000,
      onEvent: async (level, text) => { await edit(shop, id, (_row, state) => { own(state); if (level === "request") state.requests++; message(state, level, text); return {}; }); },
    });
    const completed = await edit(shop, id, (_row, state) => {
      own(state);
      state.found = [...new Set([...state.found, ...found])];
      state.position = Math.min(state.position + 25, state.candidates.length);
      const done = state.position === state.candidates.length;
      state.activeMs = (state.activeMs || 0) + Math.max(0, Date.now() - (state.lease.startedAt || Date.now()));
      state.lease = null;
      message(state, "success", done ? `Duplicate check complete. ${state.found.length} existing page handles found. Opening Review.` : `${state.position}/${state.candidates.length} checked; ${state.found.length} existing page handles found.`);
      return { status: done ? "completed" : "running", successCount: state.position, ...(done ? { completedAt: new Date() } : {}) };
    });
    return reviewCheckView(completed);
  } catch (error) {
    const failed = await edit(shop, id, (_row, state) => {
      if (state.lease?.owner !== owner) return null;
      state.error = String(error?.message || "The duplicate check could not finish.").slice(0, 1000);
      state.activeMs = (state.activeMs || 0) + Math.max(0, Date.now() - (state.lease.startedAt || Date.now())); state.lease = null;
      message(state, "error", state.error);
      return { status: "failed" };
    });
    return reviewCheckView(failed);
  }
}
