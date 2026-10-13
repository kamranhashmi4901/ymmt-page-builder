import db from "../db.server";

export async function createActionSession({
  shop,
  actionType,
  totalPages = 0,
  filters = null,
  id = null,
  status = "running",
}) {
  return db.pageActionSession.create({
    data: {
      ...(id ? { id } : {}),
      shop,
      actionType,
      totalPages,
      filterSnapshot: filters ? JSON.stringify(filters) : null,
      status,
    },
  });
}

export async function logPageBeforeChange({
  sessionId,
  shopifyPageId,
  handle,
  action,
  beforeData,
}) {
  return db.pageChangeLog.create({
    data: {
      sessionId,
      shopifyPageId,
      handle,
      action,
      beforeData: beforeData ? JSON.stringify(beforeData) : null,
      status: "pending",
    },
  });
}

export async function markPageChangeSuccess({ changeId, afterData = null }) {
  return db.pageChangeLog.update({
    where: { id: changeId },
    data: {
      status: "success",
      afterData: afterData ? JSON.stringify(afterData) : null,
    },
  });
}

export async function markPageChangeFailed({ changeId, error }) {
  return db.pageChangeLog.update({
    where: { id: changeId },
    data: {
      status: "failed",
      errorMessage: error instanceof Error ? error.message : String(error),
    },
  });
}

export async function actionCounts(sessionId, total) {
  const groups = await db.pageChangeLog.groupBy({ by: ["status"], where: { sessionId }, _count: { _all: true } });
  const counts = Object.fromEntries(groups.map((g) => [g.status, g._count._all]));
  const updated = counts.success || 0, unchanged = counts.unchanged || 0, failed = counts.failed || 0;
  const processed = updated + unchanged + failed;
  return { updated, unchanged, failed, processed, remaining: Math.max(0, total - processed), progress: total ? Math.min(100, Math.floor(processed / total * 100)) : 0 };
}

export async function completeActionSession(sessionId) {
  const session = await db.pageActionSession.findUnique({ where: { id: sessionId } });
  const counts = await actionCounts(sessionId, session.totalPages);
  return db.pageActionSession.update({ where: { id: sessionId }, data: {
    status: counts.remaining ? "incomplete" : counts.failed ? "needs_review" : "completed",
    successCount: counts.updated, failedCount: counts.failed,
    completedAt: counts.remaining || counts.failed ? null : new Date(),
  } });
}

export async function getRecentActionSessions(shop, limit = 20, { actionType = "", offset = 0 } = {}) {
  const rows = await db.pageActionSession.findMany({ where: { shop, ...(actionType ? { actionType } : { actionType: { not: "review-check" } }) }, orderBy: { createdAt: "desc" }, take: limit, skip: Math.max(0, Number(offset) || 0),
    select: { id: true, actionType: true, status: true, totalPages: true, successCount: true, failedCount: true, createdAt: true, completedAt: true, rolledBackAt: true } });
  return Promise.all(rows.map(async (row) => {
    const counts = await actionCounts(row.id, row.totalPages);
    const status = ["completed", "completed_with_errors"].includes(row.status) ? counts.remaining ? "incomplete" : counts.failed ? "needs_review" : "completed" : row.status;
    return { ...row, status, successCount: counts.updated, failedCount: counts.failed, ...counts };
  }));
}

export async function getActionSession(shop, sessionId, { summaryOnly = false } = {}) {
  return db.pageActionSession.findFirst({
    where: {
      id: sessionId,
      shop,
    },
    include: {
      changes: { orderBy: { createdAt: "asc" }, ...(summaryOnly ? { select: { id: true, handle: true, action: true, status: true, errorMessage: true, createdAt: true, rolledBackAt: true } } : {}) },
    },
  });
}

export async function markChangeRolledBack(changeId) {
  return db.pageChangeLog.update({
    where: { id: changeId },
    data: {
      rolledBackAt: new Date(),
    },
  });
}

export async function markSessionRolledBack(sessionId) {
  return db.pageActionSession.update({
    where: { id: sessionId },
    data: {
      status: "rolled_back",
      rolledBackAt: new Date(),
    },
  });
}

export async function getActionSessionHeader(shop, sessionId) {
  return db.pageActionSession.findFirst({ where: { shop, id: sessionId }, select: { id: true, actionType: true } });
}
