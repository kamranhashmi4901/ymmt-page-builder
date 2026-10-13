import { randomUUID, createHash } from "node:crypto";
import db from "../db.server";
import {
  loadManageJsonSource,
  matchManageJsonSource,
} from "./ymmt-manage-json-source.server";
import { proposeCorrection } from "./ymmt-page-file-corrections.server";
import { pageUpdateGraphql } from "./page-update-api.server";
import { createActionSession, actionCounts } from "./page-change-log.server";

const KIND = "page-update-v2",
  BATCH_SIZE = 10,
  LEASE_MS = 180000;
const sourceCache = new Map();
const MINI_FIELDS = `id title handle body templateSuffix isPublished publishedAt
vehicle: metafield(namespace: "ymmt", key: "vehicle") { id type value }
productHandle: metafield(namespace: "ymmt", key: "product_handle") { id type value }
sourceProductHandle: metafield(namespace: "ymmt", key: "source_product_handle") { id type value }`;
const READ = `#graphql
query PageUpdateBatch($ids: [ID!]!) { nodes(ids: $ids) { ... on Page { ${MINI_FIELDS}
metafields(first: 50, namespace: "ymmt") { nodes { id namespace key type value } } } } }`;
const VERIFY = `#graphql
query VerifyUpdatedPages($ids: [ID!]!) { nodes(ids: $ids) { ... on Page { ${MINI_FIELDS} } } }`;
const WRITE = `#graphql
mutation UpdateQueuedPage($id: ID!, $page: PageUpdateInput!) { pageUpdate(id: $id, page: $page) { page { id } userErrors { field message } } }`;
const terminal = (status) =>
  ["success", "unchanged", "failed"].includes(status);
export function updatePlan(session) {
  try {
    const p = JSON.parse(session.filterSnapshot || "null");
    return p?.kind === KIND ? p : null;
  } catch {
    return null;
  }
}
async function root(shop, id) {
  const s = await db.pageActionSession.findFirst({ where: { shop, id } });
  if (!s)
    throw new Response("Update job not found for this store.", { status: 404 });
  return s;
}
async function edit(shop, id, change) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const session = await root(shop, id),
      p = updatePlan(session);
    if (!p)
      throw new Error(
        "This older session has no resumable queue. Its saved results remain available.",
      );
    const data = change(session, p);
    if (!data) return session;
    p.revision = (p.revision || 0) + 1;
    const result = await db.pageActionSession.updateMany({
      where: {
        id,
        shop,
        status: session.status,
        filterSnapshot: session.filterSnapshot,
      },
      data: { ...data, filterSnapshot: JSON.stringify(p) },
    });
    if (result.count === 1) return root(shop, id);
  }
  throw new Error(
    "The job checkpoint changed in another request. Refresh its status.",
  );
}
function event(p, level, message) {
  p.message = message;
  p.updatedAt = new Date().toISOString();
  p.logs.push({ time: p.updatedAt, level, message });
  p.logs = p.logs.slice(-80);
}
async function source(shop, id) {
  const key = `${shop}|${id}`;
  if (!sourceCache.has(key)) {
    const data = await loadManageJsonSource(shop, id);
    sourceCache.set(key, data);
    if (sourceCache.size > 4)
      sourceCache.delete(sourceCache.keys().next().value);
  }
  return sourceCache.get(key);
}
export async function createPageUpdateJob(
  shop,
  ids,
  sourceId,
  searchJobId = "",
  requestKey = "",
) {
  ids = [...new Set(ids)];
  if (
    !ids.length ||
    ids.length > 60000 ||
    ids.some((id) => !/^gid:\/\/shopify\/Page\/\d+$/.test(id))
  )
    throw new Error("Select 1–60,000 valid page IDs.");
  const nonce = /^[0-9a-f-]{36}$/i.test(requestKey) ? requestKey : randomUUID();
  const id = `pu_${createHash("sha256").update(`${shop}|${nonce}`).digest("hex")}`;
  const previous = await db.pageActionSession.findFirst({
    where: { shop, id },
  });
  const matches = (session) => {
    const old = updatePlan(session);
    return (
      old?.sourceId === sourceId &&
      JSON.stringify([...old.ids].sort()) === JSON.stringify([...ids].sort())
    );
  };
  if (previous) {
    if (!matches(previous))
      throw new Error(
        "This submission key belongs to a different selection. Refresh Manage Pages before starting another job.",
      );
    return previous;
  }
  await source(shop, sourceId);
  const p = {
    kind: KIND,
    revision: 0,
    ids,
    queue: ids,
    position: 0,
    sourceId,
    searchJobId: /^[a-zA-Z0-9_-]{1,100}$/.test(searchJobId) ? searchJobId : "",
    lease: null,
    apiRequests: 0,
    logs: [],
    updatedAt: new Date().toISOString(),
  };
  event(
    p,
    "info",
    `Saved ${ids.length} page IDs. No pages have been updated yet.`,
  );
  try {
    return await createActionSession({
      id,
      shop,
      actionType: "update-content",
      totalPages: ids.length,
      filters: p,
      status: "ready",
    });
  } catch (error) {
    if (error.code !== "P2002") throw error;
    const duplicate = await root(shop, id);
    if (!matches(duplicate))
      throw new Error(
        "The submission key has conflicting page data. Refresh Manage Pages.",
      );
    return duplicate;
  }
}
export async function controlPageUpdateJob(shop, id, intent) {
  const s = await root(shop, id),
    p = updatePlan(s);
  if (!p || s.rolledBackAt)
    throw new Error(
      "This session cannot resume. Open its saved results for details.",
    );
  if (intent === "pause")
    return edit(shop, id, (_s, state) => {
      event(
        state,
        "info",
        "Pause requested. Pages already submitted will be verified and saved.",
      );
      return { status: "paused" };
    });
  if (!["resume", "retry-failed"].includes(intent))
    throw new Error("Unknown update action.");
  const rows = await db.pageChangeLog.findMany({
    where: { sessionId: id },
    select: { shopifyPageId: true, status: true },
  });
  const states = new Map(rows.map((row) => [row.shopifyPageId, row.status]));
  const queue = p.ids.filter((pageId) =>
    intent === "retry-failed"
      ? states.get(pageId) === "failed"
      : !terminal(states.get(pageId)),
  );
  const counts = await actionCounts(id, s.totalPages);
  return edit(shop, id, (session, state) => {
    if (state.lease?.until > Date.now())
      throw new Error(
        "A batch still owns this job. Wait for it to finish or its interrupted lock to expire.",
      );
    if (!queue.length) {
      event(
        state,
        "info",
        counts.remaining
          ? "No failed pages to retry. Use Resume for pending pages."
          : counts.failed
            ? "Pending work is finished, but failed pages need review or Retry Failed Pages."
            : "All selected pages have saved successful or already-correct results.",
      );
      return {
        status: counts.remaining
          ? "paused"
          : counts.failed
            ? "needs_review"
            : "completed",
        successCount: counts.updated,
        failedCount: counts.failed,
        completedAt: counts.remaining || counts.failed ? null : new Date(),
      };
    }
    state.queue = queue;
    state.position = 0;
    state.retryFailed = intent === "retry-failed";
    event(
      state,
      "info",
      `${intent === "retry-failed" ? "Retrying" : "Resuming"} ${queue.length} pages; successful results are retained.`,
    );
    return { status: "running", completedAt: null };
  });
}
export async function pageUpdateView(
  shop,
  id,
  offset = 0,
  { includeRows = true } = {},
) {
  const s = await root(shop, id),
    p = updatePlan(s),
    counts = await actionCounts(id, s.totalPages);
  offset = Math.max(0, Math.floor(Number(offset) || 0));
  const select = {
    id: true,
    shopifyPageId: true,
    handle: true,
    status: true,
    errorMessage: true,
    createdAt: true,
    rolledBackAt: true,
  };
  const rows = includeRows
    ? await db.pageChangeLog.findMany({
        where: { sessionId: id },
        select,
        orderBy: { createdAt: "asc" },
        skip: offset,
        take: 50,
      })
    : [];
  const recorded = await db.pageChangeLog.count({ where: { sessionId: id } });
  const busy = Boolean(p?.lease?.until > Date.now());
  let status = s.status;
  if (["completed", "completed_with_errors"].includes(status))
    status = counts.remaining
      ? "incomplete"
      : counts.failed
        ? "needs_review"
        : "completed";
  return {
    revision: p?.revision || 0,
    id: s.id,
    actionType: s.actionType,
    createdAt: s.createdAt,
    status,
    rolledBackAt: s.rolledBackAt,
    total: s.totalPages,
    ...counts,
    rows,
    recorded,
    offset,
    busy,
    leaseUntil: p?.lease?.until || 0,
    resumable: Boolean(p && !s.rolledBackAt),
    apiRequests: p?.apiRequests || 0,
    message:
      p?.message ||
      "Saved session results. Older sessions have no saved queue to resume.",
    lastActivity: p?.updatedAt || s.completedAt || s.createdAt,
    logs: p?.logs || [],
    searchJobId: p?.searchJobId || "",
    fetchedAt: Date.now(),
  };
}
export async function advancePageUpdateJob(shop, id, admin) {
  const owner = randomUUID();
  const claimed = await edit(shop, id, (session, p) => {
    if (
      session.status !== "running" ||
      session.rolledBackAt ||
      p.lease?.until > Date.now()
    )
      return null;
    p.lease = { owner, until: Date.now() + LEASE_MS };
    event(p, "info", "Reading the next saved page batch.");
    return {};
  });
  if (updatePlan(claimed)?.lease?.owner !== owner) return;
  let heartbeatError,
    renewing = false;
  const assert = () => {
    if (heartbeatError) throw heartbeatError;
  };
  const owns = (p) => {
    assert();
    if (p.lease?.owner !== owner || p.lease.until <= Date.now())
      throw new Error(
        "Batch ownership expired. Resume once the active request stops.",
      );
  };
  const change = (fn) =>
    edit(shop, id, (s, p) => {
      owns(p);
      return fn(s, p);
    });
  const timer = setInterval(async () => {
    if (renewing) return;
    renewing = true;
    try {
      await change((_s, p) => {
        p.lease.until = Date.now() + LEASE_MS;
        return {};
      });
    } catch (error) {
      heartbeatError = error;
    } finally {
      renewing = false;
    }
  }, 20000);
  timer.unref?.();
  const budget = {};
  const api = (document, variables) =>
    pageUpdateGraphql(admin, document, variables, {
      budget,
      assertOwner: assert,
      onEvent: async (level, message) => {
        await change((_s, p) => {
          if (level === "request") p.apiRequests++;
          else event(p, level, message);
          return {};
        });
      },
    });
  const receipt = (changeId, data) =>
    db.pageChangeLog.update({ where: { id: changeId }, data });
  let fatal;
  try {
    const s = await root(shop, id),
      p = updatePlan(s),
      jsonSource = await source(shop, p.sourceId);
    const ids = p.queue.slice(p.position, p.position + BATCH_SIZE);
    const oldRows = await db.pageChangeLog.findMany({
      where: { sessionId: id, shopifyPageId: { in: ids } },
    });
    const existing = new Map(oldRows.map((row) => [row.shopifyPageId, row]));
    const entries = [];
    // Every attempted page has a durable row before its Shopify read can fail.
    for (const pageId of ids) {
      let row = existing.get(pageId);
      if (!row)
        row = await db.pageChangeLog.create({
          data: {
            sessionId: id,
            shopifyPageId: pageId,
            handle: pageId,
            action: "update-content",
            status: "pending",
          },
        });
      if (row.status === "failed" && p.retryFailed)
        row = await receipt(row.id, { status: "pending", errorMessage: null });
      entries.push({ pageId, row });
    }
    const wanted = entries.filter((e) => !terminal(e.row.status));
    const read = wanted.length
      ? await api(READ, { ids: wanted.map((e) => e.pageId) })
      : { nodes: [] };
    if (!Array.isArray(read.nodes) || read.nodes.length !== wanted.length)
      throw new Error(
        "Shopify returned an incomplete page batch. No completion checkpoint was saved.",
      );
    const pages = new Map(
      read.nodes.filter(Boolean).map((page) => [page.id, page]),
    );
    const work = [];
    for (const entry of wanted) {
      const page = pages.get(entry.pageId);
      if (!page) {
        await receipt(entry.row.id, {
          status: "failed",
          errorMessage: "Page was not found in Shopify.",
        });
        await change((_s, state) => {
          event(state, "error", `${entry.pageId}: page not found.`);
          return {};
        });
        continue;
      }
      let proposal, target;
      try {
        target = matchManageJsonSource(page, jsonSource);
        proposal = proposeCorrection(page, {
          id: page.id,
          handle: page.handle,
          target,
        });
        if (proposal.blocked) throw new Error(proposal.issues.join("; "));
      } catch (error) {
        await receipt(entry.row.id, {
          handle: page.handle,
          status: "failed",
          errorMessage: String(error.message).slice(0, 1000),
        });
        await change((_s, state) => {
          event(state, "error", `${page.handle}: ${error.message}`);
          return {};
        });
        continue;
      }
      if (!proposal.changed) {
        const status = ["submitting", "verifying"].includes(entry.row.status)
          ? "success"
          : "unchanged";
        await receipt(entry.row.id, {
          handle: page.handle,
          status,
          errorMessage: null,
          afterData: JSON.stringify(page),
        });
        await change((_s, state) => {
          event(
            state,
            "success",
            `${page.handle}: ${status === "success" ? "verified an interrupted update" : "already correct; no update needed"}.`,
          );
          return {};
        });
        continue;
      }
      if (!entry.row.beforeData)
        await receipt(entry.row.id, {
          handle: page.handle,
          beforeData: JSON.stringify(page),
        });
      work.push({ ...entry, page, target, proposal });
    }
    const submitted = [];
    let next = 0;
    const writeWorker = async () => {
      while (next < work.length && !fatal) {
        const entry = work[next++];
        const latest = await root(shop, id);
        owns(updatePlan(latest));
        if (latest.status !== "running") break;
        await receipt(entry.row.id, {
          status: "submitting",
          errorMessage: null,
        });
        await change((_s, state) => {
          event(state, "info", `Updating ${entry.page.handle}.`);
          return {};
        });
        try {
          const data = await api(WRITE, {
            id: entry.pageId,
            page: entry.proposal.input,
          });
          const result = data.pageUpdate;
          if (result?.userErrors?.length) {
            const message = result.userErrors.map((e) => e.message).join("; ");
            await receipt(entry.row.id, {
              status: "failed",
              errorMessage: message,
            });
            await change((_s, state) => {
              event(state, "error", `${entry.page.handle}: ${message}`);
              return {};
            });
            continue;
          }
          if (result?.page?.id !== entry.pageId)
            throw new Error(
              "Shopify did not confirm the page write. Its result will be checked on Resume.",
            );
          await receipt(entry.row.id, { status: "verifying" });
          submitted.push(entry);
        } catch (error) {
          fatal = error;
        }
      }
    };
    // Two low-cost mutations in flight; ID reads/verification remain batched.
    await Promise.all([
      writeWorker().catch((error) => {
        fatal = error;
      }),
      writeWorker().catch((error) => {
        fatal = error;
      }),
    ]);
    if (submitted.length) {
      await change((_s, state) => {
        event(state, "info", `Verifying ${submitted.length} submitted pages.`);
        return {};
      });
      const verified = await api(VERIFY, {
        ids: submitted.map((e) => e.pageId),
      });
      if (
        !Array.isArray(verified.nodes) ||
        verified.nodes.length !== submitted.length
      )
        throw new Error(
          "Shopify returned an incomplete verification batch. Pending writes will be checked on Resume.",
        );
      const after = new Map(
        verified.nodes.filter(Boolean).map((page) => [page.id, page]),
      );
      for (const entry of submitted) {
        const page = after.get(entry.pageId),
          diff = proposeCorrection(page, {
            id: entry.pageId,
            handle: entry.page.handle,
            target: entry.target,
          });
        const ok =
          !diff.blocked &&
          !diff.changed &&
          page.productHandle?.value === entry.page.productHandle?.value &&
          page.sourceProductHandle?.value ===
            entry.page.sourceProductHandle?.value;
        await receipt(entry.row.id, {
          status: ok ? "success" : "failed",
          afterData: page ? JSON.stringify(page) : null,
          errorMessage: ok
            ? null
            : "Saved values or retained product links did not match after readback. Review this page before retrying.",
        });
        await change((_s, state) => {
          event(
            state,
            ok ? "success" : "error",
            `${entry.page.handle}: ${ok ? "updated and verified" : "verification failed; needs review"}.`,
          );
          return {};
        });
      }
    }
    if (fatal) throw fatal;
    const states = await db.pageChangeLog.findMany({
      where: { sessionId: id, shopifyPageId: { in: ids } },
      select: { shopifyPageId: true, status: true },
    });
    const map = new Map(states.map((row) => [row.shopifyPageId, row.status]));
    let advanced = 0;
    for (const pageId of ids) {
      if (!terminal(map.get(pageId))) break;
      advanced++;
    }
    const counts = await actionCounts(id, s.totalPages);
    await change((session, state) => {
      state.position += advanced;
      const done = state.position >= state.queue.length;
      let status = session.status;
      if (done)
        status = counts.remaining
          ? "paused"
          : counts.failed
            ? "needs_review"
            : "completed";
      event(
        state,
        status === "completed" ? "success" : counts.failed ? "error" : "info",
        `${counts.processed}/${s.totalPages} checked: ${counts.updated} updated, ${counts.unchanged} already correct, ${counts.failed} failed, ${counts.remaining} remaining.`,
      );
      return {
        status,
        successCount: counts.updated,
        failedCount: counts.failed,
        completedAt: status === "completed" ? new Date() : null,
      };
    });
  } catch (error) {
    await edit(shop, id, (_s, p) => {
      if (p.lease?.owner !== owner) return null;
      event(
        p,
        "error",
        `Stopped safely: ${String(error.message || error).slice(0, 800)}`,
      );
      return { status: "paused", completedAt: null };
    });
  } finally {
    clearInterval(timer);
    await edit(shop, id, (_s, p) => {
      if (p.lease?.owner !== owner) return null;
      p.lease = null;
      return {};
    });
  }
}
