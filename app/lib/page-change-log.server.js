import db from "../db.server";

export async function createActionSession({
  shop,
  actionType,
  totalPages = 0,
  filters = null,
}) {
  return db.pageActionSession.create({
    data: {
      shop,
      actionType,
      totalPages,
      filterSnapshot: filters ? JSON.stringify(filters) : null,
      status: "running",
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

export async function completeActionSession(sessionId) {
  const [successCount, failedCount] = await Promise.all([
    db.pageChangeLog.count({
      where: {
        sessionId,
        status: "success",
      },
    }),
    db.pageChangeLog.count({
      where: {
        sessionId,
        status: "failed",
      },
    }),
  ]);

  return db.pageActionSession.update({
    where: { id: sessionId },
    data: {
      status: failedCount > 0 ? "completed_with_errors" : "completed",
      successCount,
      failedCount,
      completedAt: new Date(),
    },
  });
}

export async function getRecentActionSessions(shop, limit = 20) {
  return db.pageActionSession.findMany({
    where: { shop },
    orderBy: {
      createdAt: "desc",
    },
    take: limit,
    include: {
      changes: true,
    },
  });
}

export async function getActionSession(shop, sessionId) {
  return db.pageActionSession.findFirst({
    where: {
      id: sessionId,
      shop,
    },
    include: {
      changes: true,
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
