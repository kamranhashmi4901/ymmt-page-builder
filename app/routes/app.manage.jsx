import { useEffect, useRef, useState } from "react";

import {
  Form,
  Link,
  useActionData,
  useFetcher,
  useLoaderData,
  useNavigation,
  useNavigate,
} from "react-router";

import { authenticate } from "../shopify.server";

import {
  deleteShopifyPage,
  getShopifyPageSnapshot,
  updateYMMTProductHandle,
  updateYMMTPageContent,
  restoreShopifyPageSnapshot,
  recreateShopifyPageFromSnapshot,
} from "../lib/shopify-manage-pages.server";

import { parseYMMT } from "../lib/ymmt-parser.server";
import { saveManageJsonSource, loadManageJsonSource } from "../lib/ymmt-manage-json-source.server";

import {
  createActionSession,
  logPageBeforeChange,
  markPageChangeSuccess,
  markPageChangeFailed,
  completeActionSession,
  getRecentActionSessions,
  getActionSession,
  markChangeRolledBack,
  markSessionRolledBack,
} from "../lib/page-change-log.server";

import {
  createYMMTPageSearchJob,
  startYMMTPageSearchJob,
} from "../lib/ymmt-page-search-jobs.server";

/* =========================================================
   LOADER
========================================================= */

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  const url = new URL(request.url);

  const filters = {
    search: url.searchParams.get("search") || "",

    year: url.searchParams.get("year") || "",

    make: url.searchParams.get("make") || "",

    model: url.searchParams.get("model") || "",

    trim: url.searchParams.get("trim") || "",

    manufacturer: url.searchParams.get("manufacturer") || "",

    compatibility: url.searchParams.get("compatibility") || "",

    warning: url.searchParams.get("warning") || "",

    productHandle: url.searchParams.get("productHandle") || "",

    status: url.searchParams.get("status") || "",
  };

  const hasFilters = Object.values(filters).some(
    (value) => String(value).trim() !== "",
  );

  // Manual search now runs as a persistent background job so large live stores
  // do not block the route loader or stop after the first 2,000 pages.
  const pages = [];

  const recentSessions = await getRecentActionSessions(session.shop, 10);

  const sessionId = url.searchParams.get("sessionId") || "";

  let selectedSession = null;

  if (sessionId) {
    selectedSession = await getActionSession(session.shop, sessionId);
  }

  return {
    shop: session.shop,
    pages,
    filters,
    recentSessions,
    hasFilters,
    selectedSession,
  };
};

/* =========================================================
   ACTION
========================================================= */

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  const shop = session.shop;

  const formData = await request.formData();

  const intent = String(formData.get("intent") || "");

  /* -------------------------------------------------------
     ROLLBACK
  ------------------------------------------------------- */

  if (intent === "rollback-session") {
    const sessionId = String(formData.get("sessionId") || "");

    if (!sessionId) {
      return {
        success: false,
        error: "Missing session ID.",
      };
    }

    const actionSession = await getActionSession(shop, sessionId);

    if (!actionSession) {
      return {
        success: false,
        error: "Session not found.",
      };
    }

    if (actionSession.rolledBackAt) {
      return {
        success: false,
        error: "This session has already been rolled back.",
      };
    }

    const rollbackResults = [];

    for (const change of actionSession.changes) {
      if (change.status !== "success" || change.rolledBackAt) {
        continue;
      }

      try {
        const snapshot = JSON.parse(change.beforeData);

        if (change.action === "delete") {
          const recreatedPage = await recreateShopifyPageFromSnapshot(
            admin,
            snapshot,
          );

          await markChangeRolledBack(change.id);

          rollbackResults.push({
            changeId: change.id,

            status: "restored",

            handle: recreatedPage.handle,

            recreatedPageId: recreatedPage.id,

            message: "Deleted page recreated successfully.",
          });

          continue;
        }

        await restoreShopifyPageSnapshot(admin, snapshot);

        await markChangeRolledBack(change.id);

        rollbackResults.push({
          changeId: change.id,

          status: "restored",

          handle: change.handle,
        });
      } catch (error) {
        rollbackResults.push({
          changeId: change.id,

          status: "failed",

          handle: change.handle,

          message: error.message,
        });
      }
    }

    const restored = rollbackResults.filter(
      (result) => result.status === "restored",
    ).length;

    const failures = rollbackResults.filter(
      (result) => result.status === "failed",
    ).length;

    const skipped = rollbackResults.filter(
      (result) => result.status === "skipped",
    ).length;

    if (restored > 0 && failures === 0 && skipped === 0) {
      await markSessionRolledBack(sessionId);
    }

    return {
      success: true,

      intent,

      rollbackResults,

      restored,

      failed: failures,

      skipped,
    };
  }

  /* -------------------------------------------------------
     MANUAL SEARCH
  ------------------------------------------------------- */

  if (intent === "manual-search") {
    const filters = {
      search: String(formData.get("search") || "").trim(),
      year: String(formData.get("year") || "").trim(),
      make: String(formData.get("make") || "").trim(),
      model: String(formData.get("model") || "").trim(),
      trim: String(formData.get("trim") || "").trim(),
      manufacturer: String(formData.get("manufacturer") || "").trim(),
      compatibility: String(formData.get("compatibility") || "").trim(),
      warning: String(formData.get("warning") || "").trim(),
      productHandle: String(formData.get("productHandle") || "").trim(),
      status: String(formData.get("status") || "").trim(),
    };

    const hasManualFilters = Object.values(filters).some(Boolean);

    if (!hasManualFilters) {
      return {
        success: false,
        intent,
        error: "Please enter at least one manual search filter.",
      };
    }

    try {
      const searchJob = await createYMMTPageSearchJob({
        shop,
        mode: "manual",
        filters,
        records: [],
        fileName: "Manual Search",
      });

      startYMMTPageSearchJob({
        jobId: searchJob.id,
        shop,
        admin,
      });

      return {
        success: true,
        intent: "manual-search-start",
        jobId: searchJob.id,
        filters,
      };
    } catch (error) {
      return {
        success: false,
        intent,
        error: error.message || "Unable to start manual page search.",
      };
    }
  }

  /* -------------------------------------------------------
     JSON SEARCH
  ------------------------------------------------------- */

  if (intent === "json-search") {
    const file = formData.get("ymmtFile");

    if (!file || typeof file.text !== "function") {
      return {
        success: false,
        intent,

        error: "Please select a YMMT JSON file.",
      };
    }

    if (
      file.type &&
      file.type !== "application/json" &&
      !file.name?.toLowerCase().endsWith(".json")
    ) {
      return {
        success: false,
        intent,

        error: "Only JSON files are supported.",
      };
    }

    try {
      const text = await file.text();

      const raw = JSON.parse(text);

      const parsed = parseYMMT(raw);

      if (!parsed.entries?.length) {
        return {
          success: false,

          intent,

          error: "No YMMT vehicle records were found in this JSON file.",
        };
      }

      const jsonSourceId = await saveManageJsonSource(shop, parsed.entries, file.name);

      /*
       * Create persistent search job.
       * Action returns immediately.
       */
      const searchJob = await createYMMTPageSearchJob({
        shop,
        mode: "json",
        fileName: file.name,
        records: parsed.entries,
      });

      /*
       * Start the background
       * Shopify search.
       */
      startYMMTPageSearchJob({
        jobId: searchJob.id,

        shop,

        admin,
      });

      return {
        success: true,

        intent: "json-search-start",

        jobId: searchJob.id,

        fileName: file.name,

        totalRecords: parsed.entries.length,
        jsonSourceId,
      };
    } catch (error) {
      return {
        success: false,

        intent,

        error: error.message || "Unable to start JSON page search.",
      };
    }
  }

  /* -------------------------------------------------------
     ALL OTHER ACTIONS REQUIRE PAGES
  ------------------------------------------------------- */

  const pageIds = formData.getAll("pageIds").map(String);

  if (!pageIds.length) {
    return {
      success: false,

      error: "Please select at least one page.",
    };
  }

  const allowedIntents = ["update-product", "update-content", "delete"];

  if (!allowedIntents.includes(intent)) {
    return {
      success: false,

      error: "Unknown manage action.",
    };
  }

  const results = [];

  /* -------------------------------------------------------
     UPDATE PRODUCT
  ------------------------------------------------------- */

  if (intent === "update-product") {
    const productHandle = String(formData.get("productHandle") || "")
      .trim()
      .toLowerCase();

    if (!productHandle) {
      return {
        success: false,

        error: "Product handle is required.",
      };
    }

    if (!/^[a-z0-9-]+$/.test(productHandle)) {
      return {
        success: false,

        error:
          "Product handle can only contain lowercase letters, numbers, and hyphens.",
      };
    }

    const actionSession = await createActionSession({
      shop,

      actionType: "update-product",

      totalPages: pageIds.length,

      filters: {
        productHandle,
      },
    });

    for (const pageId of pageIds) {
      let changeLog = null;

      try {
        const beforeSnapshot = await getShopifyPageSnapshot(admin, pageId);

        changeLog = await logPageBeforeChange({
          sessionId: actionSession.id,

          shopifyPageId: pageId,

          handle: beforeSnapshot.handle || "",

          action: "update-product",

          beforeData: beforeSnapshot,
        });

        await updateYMMTProductHandle(admin, {
          pageId,
          productHandle,
        });

        const afterSnapshot = await getShopifyPageSnapshot(admin, pageId);

        await markPageChangeSuccess({
          changeId: changeLog.id,

          afterData: afterSnapshot,
        });

        results.push({
          pageId,

          title: afterSnapshot.title,

          handle: afterSnapshot.handle,

          status: "updated",
        });
      } catch (error) {
        if (changeLog) {
          await markPageChangeFailed({
            changeId: changeLog.id,

            error,
          });
        }

        results.push({
          pageId,

          status: "failed",

          message: error.message || "Unable to update product handle.",
        });
      }
    }

    await completeActionSession(actionSession.id);

    return {
      success: true,

      intent,

      sessionId: actionSession.id,

      updated: results.filter((result) => result.status === "updated").length,

      failed: results.filter((result) => result.status === "failed").length,

      results,
    };
  }

  /* -------------------------------------------------------
     UPDATE CONTENT
  ------------------------------------------------------- */

  if (intent === "update-content") {
    let jsonSource;
    try {
      jsonSource = await loadManageJsonSource(shop, String(formData.get("jsonSourceId") || ""));
    } catch (error) {
      return { success: false, intent, error: error.message };
    }
    const actionSession = await createActionSession({
      shop,

      actionType: "update-content",

      totalPages: pageIds.length,
    });

    for (const pageId of pageIds) {
      let changeLog = null;

      try {
        const beforeSnapshot = await getShopifyPageSnapshot(admin, pageId);

        changeLog = await logPageBeforeChange({
          sessionId: actionSession.id,

          shopifyPageId: pageId,

          handle: beforeSnapshot.handle || "",

          action: "update-content",

          beforeData: beforeSnapshot,
        });

        await updateYMMTPageContent(admin, pageId, { jsonSource });

        const afterSnapshot = await getShopifyPageSnapshot(admin, pageId);

        await markPageChangeSuccess({
          changeId: changeLog.id,

          afterData: afterSnapshot,
        });

        results.push({
          pageId,

          title: afterSnapshot.title,

          handle: afterSnapshot.handle,

          status: "updated",
        });
      } catch (error) {
        if (changeLog) {
          await markPageChangeFailed({
            changeId: changeLog.id,

            error,
          });
        }

        results.push({
          pageId,

          status: "failed",

          message: error.message || "Unable to update page content.",
        });
      }
    }

    await completeActionSession(actionSession.id);

    return {
      success: true,

      intent,

      sessionId: actionSession.id,

      updated: results.filter((result) => result.status === "updated").length,

      failed: results.filter((result) => result.status === "failed").length,

      results,
    };
  }

  /* -------------------------------------------------------
     DELETE
  ------------------------------------------------------- */

  if (intent === "delete") {
    const actionSession = await createActionSession({
      shop,

      actionType: "delete",

      totalPages: pageIds.length,
    });

    for (const pageId of pageIds) {
      let changeLog = null;

      try {
        const beforeSnapshot = await getShopifyPageSnapshot(admin, pageId);

        changeLog = await logPageBeforeChange({
          sessionId: actionSession.id,

          shopifyPageId: pageId,

          handle: beforeSnapshot.handle || "",

          action: "delete",

          beforeData: beforeSnapshot,
        });

        await deleteShopifyPage(admin, pageId);

        await markPageChangeSuccess({
          changeId: changeLog.id,

          afterData: null,
        });

        results.push({
          pageId,

          title: beforeSnapshot.title,

          handle: beforeSnapshot.handle,

          status: "deleted",

          message: "Page deleted successfully.",
        });
      } catch (error) {
        if (changeLog) {
          await markPageChangeFailed({
            changeId: changeLog.id,

            error,
          });
        }

        results.push({
          pageId,

          status: "failed",

          message: error.message || "Unable to delete page.",
        });
      }
    }

    await completeActionSession(actionSession.id);

    return {
      success: true,

      intent,

      sessionId: actionSession.id,

      total: pageIds.length,

      deleted: results.filter((result) => result.status === "deleted").length,

      failed: results.filter((result) => result.status === "failed").length,

      results,
    };
  }
};

/* =========================================================
   STYLES
========================================================= */

const inputStyle = {
  width: "100%",

  boxSizing: "border-box",

  padding: "10px 12px",

  border: "1px solid #c9c9c9",

  borderRadius: "8px",

  background: "#ffffff",
};

const primaryButton = {
  padding: "10px 16px",

  borderRadius: "8px",

  border: "none",

  background: "#303030",

  color: "#ffffff",

  fontWeight: "650",

  cursor: "pointer",
};

const secondaryButton = {
  padding: "9px 14px",

  borderRadius: "8px",

  border: "1px solid #c9c9c9",

  background: "#ffffff",

  fontWeight: "600",

  cursor: "pointer",
};

const headerStyle = {
  padding: "12px",

  borderBottom: "1px solid #dedede",

  background: "#f7f7f7",

  fontSize: "12px",

  fontWeight: "650",

  whiteSpace: "nowrap",
};

const cellStyle = {
  padding: "12px",

  borderBottom: "1px solid #eeeeee",

  fontSize: "13px",

  verticalAlign: "top",
};

/* =========================================================
   COMPONENT
========================================================= */

export default function ManagePages() {
  const navigate = useNavigate();
  const {
    shop,
    pages,
    filters,
    recentSessions,
    hasFilters,
    selectedSession,
  } = useLoaderData();

  const actionData = useActionData();

  const navigation = useNavigation();

  const manualSearchFetcher = useFetcher();
  const jsonSearchFetcher = useFetcher();
  const searchFetcher = useFetcher();

  const [step, setStep] = useState("select");

  const [selectedAction, setSelectedAction] = useState("");

  const [searchMode, setSearchMode] = useState("manual");

  const [selectedIds, setSelectedIds] = useState(new Set());

  const [productHandle, setProductHandle] = useState("");

  const [deleteConfirmation, setDeleteConfirmation] = useState("");

  const [jsonFileName, setJsonFileName] = useState("");

  const fileInputRef = useRef(null);

  /* -------------------------------------------------------
     SEARCH JOB
  ------------------------------------------------------- */

  const [searchJobId, setSearchJobId] = useState(null);
  const [jsonSourceId, setJsonSourceId] = useState("");
  const [searchLogs, setSearchLogs] = useState([]);

  const searchJob = searchFetcher.data;

  useEffect(() => {
    const data = manualSearchFetcher.data;

    if (!data?.success || data.intent !== "manual-search-start") {
      return;
    }

    setSearchMode("manual");
    setJsonSourceId("");

    setSearchJobId(data.jobId);

    setSearchLogs([
      "[START] Manual search started.",
      `[QUERY] ${Object.entries(data.filters || {})
        .filter(([, value]) => String(value || "").trim())
        .map(([key, value]) => `${key}=${value}`)
        .join(", ")}`,
    ]);
  }, [manualSearchFetcher.data]);
  useEffect(() => {
    const data = jsonSearchFetcher.data;

    if (!data?.success || data.intent !== "json-search-start") {
      return;
    }

    setSearchMode("json");
    setJsonSourceId(data.jsonSourceId || "");

    setSearchJobId(data.jobId);

    setSearchLogs([
      `[START] JSON search started for ${data.fileName || "uploaded file"}.`,
    ]);
  }, [jsonSearchFetcher.data]);

  useEffect(() => {
    const message = searchJob?.message;

    if (!message) {
      return;
    }

    setSearchLogs((current) => {
      const entry = `[${new Date().toLocaleTimeString()}] ${message}`;

      if (current[current.length - 1]?.endsWith(message)) {
        return current;
      }

      return [...current, entry].slice(-100);
    });
  }, [searchJob?.message]);

  const searchRunning =
    Boolean(searchJobId) &&
    (!searchJob || ["pending", "running"].includes(searchJob.status));

  /*
   * Poll persistent search job
   * every 1.5 seconds.
   */
  useEffect(() => {
    if (!searchJobId) {
      return;
    }

    if (["completed", "failed"].includes(searchJob?.status)) {
      return;
    }

    const loadStatus = () => {
      if (searchFetcher.state !== "loading") {
        searchFetcher.load(`/app/search-status/${searchJobId}`);
      }
    };

    loadStatus();

    const timer = setInterval(loadStatus, 1500);

    return () => clearInterval(timer);
  }, [searchJobId, searchJob?.status]);

  const completedSearchPages =
    searchJob?.status === "completed" ? searchJob.pages || [] : [];

  const resultPages = completedSearchPages;

  /* -------------------------------------------------------
     ROUTER STATES
  ------------------------------------------------------- */

  const isSubmitting = navigation.state === "submitting";

  const submittingIntent = navigation.formData?.get("intent");

  const isManualStarting = manualSearchFetcher.state !== "idle";

  const isJsonStarting = jsonSearchFetcher.state !== "idle";

  const manualBusy =
    isManualStarting || (searchMode === "manual" && searchRunning);

  const jsonBusy = isJsonStarting || (searchMode === "json" && searchRunning);

  const searchBusy = manualBusy || jsonBusy;

  const hasManualResults =
    searchMode === "manual" && searchJob?.status === "completed";

  const hasJsonResults =
    searchMode === "json" && searchJob?.status === "completed";

  const canShowResults = hasManualResults || hasJsonResults;

  const isSearching = searchBusy;

  /* -------------------------------------------------------
     SELECTION
  ------------------------------------------------------- */

  const allSelected =
    resultPages.length > 0 &&
    resultPages.every((page) => selectedIds.has(page.id));

  const togglePage = (pageId) => {
    setSelectedIds((current) => {
      const next = new Set(current);

      if (next.has(pageId)) {
        next.delete(pageId);
      } else {
        next.add(pageId);
      }

      return next;
    });
  };

  const toggleAll = () => {
    if (allSelected) {
      setSelectedIds(new Set());

      return;
    }

    setSelectedIds(new Set(resultPages.map((page) => page.id)));
  };

  const switchSearchMode = (mode) => {
    if (searchBusy) {
      return;
    }

    setSearchMode(mode);

    setSelectedIds(new Set());

    setSelectedAction("");

    setProductHandle("");

    setDeleteConfirmation("");

    setJsonFileName("");

    setStep("select");
  };

  const startNewSearch = () => {
    window.location.href = "/app/manage";
  };

  /* -------------------------------------------------------
     OPERATION LOGS
  ------------------------------------------------------- */

  const actionLogs = [];

  if (isSubmitting) {
    if (submittingIntent === "update-content") {
      actionLogs.push(
        `[START] Updating content for ${selectedIds.size} selected pages...`,

        "[INFO] Creating rollback snapshots before making changes...",

        "[INFO] Rebuilding page content from YMMT vehicle data...",
      );
    }

    if (submittingIntent === "update-product") {
      actionLogs.push(
        `[START] Updating product handles for ${selectedIds.size} selected pages...`,

        "[INFO] Creating rollback snapshots before making changes...",
      );
    }

    if (submittingIntent === "delete") {
      actionLogs.push(
        `[START] Deleting ${selectedIds.size} selected pages...`,

        "[INFO] Backing up page data before deletion...",
      );
    }

    if (submittingIntent === "rollback-session") {
      actionLogs.push(
        "[START] Rolling back selected session...",

        "[INFO] Reading stored page snapshots...",

        "[INFO] Restoring reversible page changes...",
      );
    }
  }

  if (actionData?.success) {
    if (actionData.intent === "rollback-session") {
      actionLogs.push(
        `[INFO] Rollback completed. Restored: ${
          actionData.restored || 0
        }, Skipped: ${actionData.skipped || 0}, Failed: ${
          actionData.failed || 0
        }`,
      );

      actionData.rollbackResults?.forEach((result) => {
        if (result.status === "restored") {
          actionLogs.push(
            result.recreatedPageId
              ? `[SUCCESS] Recreated deleted page: ${result.handle}`
              : `[SUCCESS] Restored: ${result.handle || result.changeId}`,
          );
        } else {
          actionLogs.push(
            `[FAILED] ${result.handle || result.changeId} — ${
              result.message || "Unknown rollback error"
            }`,
          );
        }
      });
    } else {
      actionData.results?.forEach((result) => {
        if (["updated", "deleted"].includes(result.status)) {
          actionLogs.push(`[SUCCESS] ${result.handle || result.pageId}`);
        } else {
          actionLogs.push(
            `[FAILED] ${result.handle || result.pageId} — ${
              result.message || "Unknown error"
            }`,
          );
        }
      });
    }
  }

  const shouldShowLogs =
    (isSubmitting && submittingIntent !== "json-search") ||
    (actionData?.success &&
      [
        "update-product",
        "update-content",
        "delete",
        "rollback-session",
      ].includes(actionData.intent));

  return (
    <s-page heading="Manage YMMT Pages">
      <s-section>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
          <div><strong>Page maintenance</strong><p style={{ marginBottom: 0, color: "#616161" }}>Scan pages for missing or incorrect values and export affected pages as CSV or JSON.</p></div>
          <Link to="/app/scan-pages" style={{ display: "inline-block", padding: "10px 16px", borderRadius: "8px", background: "#303030", color: "white", textDecoration: "none", fontWeight: 650 }}>Scan Pages</Link>
        </div>
      </s-section>
      <style>
        {`

          .ymmt-search-toolbar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 16px;
            padding: 16px;
            border: 1px solid #e3e3e3;
            border-radius: 12px;
            background: #ffffff;
          }
          .ymmt-search-methods {
            display: flex;
            gap: 4px;
            padding: 4px;
            border: 1px solid #e3e3e3;
            border-radius: 10px;
            background: #f4f4f4;
          }
          .ymmt-search-method {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            min-height: 40px;
            padding: 9px 14px;
            border: 0;
            border-radius: 7px;
            background: transparent;
            color: #616161;
            font: inherit;
            font-size: 13px;
            font-weight: 600;
            white-space: nowrap;
            cursor: pointer;
            transition: background 150ms ease, color 150ms ease;
          }
          .ymmt-search-method:hover:not(:disabled) { background: #e8e8e8; color: #303030; }
          .ymmt-search-method[aria-pressed="true"],
          .ymmt-search-method[aria-pressed="true"]:hover:not(:disabled) {
            background: #303030;
            color: #ffffff;
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
          }
          .ymmt-search-method:focus-visible { outline: 2px solid #005bd3; outline-offset: 2px; }
          .ymmt-search-method:disabled { opacity: 0.55; cursor: not-allowed; }
          @media (max-width: 600px) {
            .ymmt-search-toolbar { align-items: stretch; flex-direction: column; gap: 12px; }
            .ymmt-search-methods { width: 100%; box-sizing: border-box; }
            .ymmt-search-method { flex: 1; min-width: 0; padding: 9px 8px; font-size: 12px; white-space: normal; }
          }

          @keyframes ymmt-spin {
            to {
              transform: rotate(360deg);
            }
          }
        `}
      </style>

      <div
        style={{
          display: "flex",

          flexDirection: "column",

          gap: "18px",
        }}
      >
        {/* =================================================
            STEP 1 SEARCH
        ================================================= */}

        {!canShowResults && (
          <>
            <div className="ymmt-search-toolbar">
              <div>
                <strong style={{ fontSize: "14px", color: "#303030" }}>
                  Search method
                </strong>
                <div
                  style={{
                    marginTop: "4px",
                    fontSize: "12px",
                    color: "#616161",
                    lineHeight: 1.5,
                  }}
                >
                  Filter pages manually or upload your YMMT JSON.
                </div>
              </div>
              <div
                className="ymmt-search-methods"
                role="group"
                aria-label="Search method"
              >
                <button
                  type="button"
                  className="ymmt-search-method"
                  aria-pressed={searchMode === "manual"}
                  disabled={searchBusy}
                  onClick={() => switchSearchMode("manual")}
                >
                  <svg
                    width="17"
                    height="17"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    aria-hidden="true"
                    style={{ flexShrink: 0 }}
                  >
                    <circle cx="10.5" cy="10.5" r="6.5" />
                    <path d="m16 16 4.5 4.5" />
                  </svg>
                  Manual Search
                </button>
                <button
                  type="button"
                  className="ymmt-search-method"
                  aria-pressed={searchMode === "json"}
                  disabled={searchBusy}
                  onClick={() => switchSearchMode("json")}
                >
                  <svg
                    width="17"
                    height="17"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                    style={{ flexShrink: 0 }}
                  >
                    <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z" />
                    <path d="M14 3v6h6M10 12l-2 2 2 2m4-4 2 2-2 2" />
                  </svg>
                  Search by JSON
                </button>
              </div>
            </div>

            {/* =============================================
                MANUAL SEARCH
            ============================================= */}

            {searchMode === "manual" && (
              <s-section>
                <strong>Find YMMT Pages</strong>

                <s-paragraph>
                  Search and filter existing YMMT pages before selecting pages
                  to manage.
                </s-paragraph>

                <manualSearchFetcher.Form method="post">
                  <input type="hidden" name="intent" value="manual-search" />

                  <div
                    style={{
                      marginTop: "16px",

                      display: "flex",

                      flexDirection: "column",

                      gap: "12px",
                    }}
                  >
                    <input
                      type="text"

                      name="search"

                      defaultValue={filters.search}

                      placeholder="Search by page title or handle"

                      style={inputStyle}
                    />

                    <div
                      style={{
                        display: "grid",

                        gridTemplateColumns:
                          "repeat(auto-fit, minmax(170px, 1fr))",

                        gap: "10px",
                      }}
                    >
                      <input
                        name="year"
                        placeholder="Year"
                        defaultValue={filters.year}
                        style={inputStyle}
                      />

                      <input
                        name="make"
                        placeholder="Make"
                        defaultValue={filters.make}
                        style={inputStyle}
                      />

                      <input
                        name="model"
                        placeholder="Model"
                        defaultValue={filters.model}
                        style={inputStyle}
                      />

                      <input
                        name="trim"
                        placeholder="Trim"
                        defaultValue={filters.trim}
                        style={inputStyle}
                      />

                      <input
                        name="manufacturer"
                        placeholder="Manufacturer"
                        defaultValue={filters.manufacturer}
                        style={inputStyle}
                      />

                      <input
                        name="compatibility"
                        placeholder="Compatibility"
                        defaultValue={filters.compatibility}
                        style={inputStyle}
                      />

                      <input
                        name="warning"
                        placeholder="Warning"
                        defaultValue={filters.warning}
                        style={inputStyle}
                      />

                      <input
                        name="productHandle"
                        placeholder="Product handle"
                        defaultValue={filters.productHandle}
                        style={inputStyle}
                      />
                    </div>

                    <select
                      name="status"

                      defaultValue={filters.status}

                      style={{
                        ...inputStyle,

                        maxWidth: "300px",
                      }}
                    >
                      <option value="">All statuses</option>

                      <option value="published">Published</option>

                      <option value="draft">Draft</option>
                    </select>

                    <div
                      style={{
                        display: "flex",

                        gap: "10px",
                      }}
                    >
                      <button
                        type="submit"

                        disabled={manualBusy}

                        style={{
                          ...primaryButton,

                          background: manualBusy ? "#8c8c8c" : "#303030",
                        }}
                      >
                        {manualBusy ? "Searching Pages..." : "Search Pages"}
                      </button>

                      {(Object.values(filters).some(Boolean) ||
                        hasManualResults) && (
                        <Link
                          to="/app/manage"

                          style={{
                            ...secondaryButton,

                            textDecoration: "none",

                            color: "#303030",
                          }}
                        >
                          Clear Filters
                        </Link>
                      )}
                    </div>
                  </div>
                </manualSearchFetcher.Form>

                {manualSearchFetcher.data?.error && (
                  <div
                    style={{
                      marginTop: "12px",
                      padding: "12px",
                      background: "#fff4f4",
                      border: "1px solid #f1b8b8",
                      borderRadius: "8px",
                      color: "#8a2e1b",
                    }}
                  >
                    {manualSearchFetcher.data.error}
                  </div>
                )}

                {(manualBusy || (searchMode === "manual" && searchJob)) && (
                  <SearchProgressPanel
                    searchJob={searchJob}
                    searchLogs={searchLogs}
                    mode="manual"
                  />
                )}
              </s-section>
            )}

            {/* =============================================
                JSON SEARCH
            ============================================= */}

            {searchMode === "json" && (
              <s-section>
                <strong>Find Pages From YMMT JSON</strong>

                <s-paragraph>
                  Upload the same YMMT JSON used for page creation. Existing
                  Shopify pages are matched by Year, Make, Model and Trim.
                </s-paragraph>

                <jsonSearchFetcher.Form
                  method="post"
                  encType="multipart/form-data"
                >
                  <input type="hidden" name="intent" value="json-search" />

                  <div
                    style={{
                      marginTop: "16px",

                      border: "1px dashed #b8b8b8",

                      borderRadius: "12px",

                      padding: "20px",

                      background: "#fafafa",
                    }}
                  >
                    <s-button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      icon="file"
                      disabled={jsonBusy}
                    >
                      Choose JSON File
                    </s-button>

                    <input
                      ref={fileInputRef}
                      id="ymmtFile"
                      type="file"
                      name="ymmtFile"
                      accept=".json,application/json"
                      required
                      disabled={jsonBusy}
                      style={{
                        display: "none",
                      }}
                      onChange={(event) =>
                        setJsonFileName(event.target.files?.[0]?.name || "")
                      }
                    />

                    <div
                      style={{
                        marginTop: "10px",

                        fontSize: "13px",

                        color: "#616161",
                      }}
                    >
                      {jsonFileName ? (
                        <>
                          Selected: <strong>{jsonFileName}</strong>
                        </>
                      ) : (
                        "Choose the same JSON format used for page creation."
                      )}
                    </div>

                    <button
                      type="submit"

                      disabled={jsonBusy}

                      style={{
                        ...primaryButton,

                        marginTop: "14px",

                        background: jsonBusy ? "#8c8c8c" : "#303030",

                        cursor: jsonBusy ? "wait" : "pointer",
                      }}
                    >
                      {jsonBusy ? "Searching Pages..." : "Find Pages From JSON"}
                    </button>
                  </div>
                </jsonSearchFetcher.Form>

                {/* LIVE SEARCH PROGRESS */}

                {(jsonBusy || searchJob) && (
                  <div
                    style={{
                      marginTop: "16px",

                      padding: "18px",

                      border: "1px solid #e3e3e3",

                      borderRadius: "12px",

                      background: "#fafafa",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",

                        justifyContent: "space-between",

                        alignItems: "center",

                        gap: "12px",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",

                          gap: "10px",

                          alignItems: "center",
                        }}
                      >
                        {searchJob?.status !== "completed" &&
                          searchJob?.status !== "failed" && <Spinner />}

                        <strong>
                          {searchJob?.status === "completed"
                            ? "Search Completed"
                            : searchJob?.status === "failed"
                              ? "Search Failed"
                              : "Searching Shopify Pages"}
                        </strong>
                      </div>

                      <strong>{searchJob?.progress ?? 0}%</strong>
                    </div>

                    <div
                      style={{
                        width: "100%",

                        height: "10px",

                        marginTop: "12px",

                        background: "#e3e3e3",

                        borderRadius: "999px",

                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          width: `${searchJob?.progress ?? 0}%`,

                          height: "100%",

                          background: "#303030",

                          transition: "width 0.3s ease",
                        }}
                      />
                    </div>

                    <div
                      style={{
                        marginTop: "16px",

                        display: "grid",

                        gridTemplateColumns:
                          "repeat(auto-fit, minmax(130px, 1fr))",

                        gap: "12px",
                      }}
                    >
                      <Stat
                        label="Current Year"
                        value={searchJob?.currentYear || "Preparing..."}
                      />

                      <Stat
                        label="Years"
                        value={`${searchJob?.processedYears || 0} / ${
                          searchJob?.totalYears || 0
                        }`}
                      />

                      <Stat
                        label="Vehicles Found"
                        value={`${searchJob?.currentYearFound || 0} / ${
                          searchJob?.currentYearTotal || 0
                        }`}
                      />

                      <Stat
                        label="Shopify Pages"
                        value={searchJob?.pagesFound || 0}
                      />

                      <Stat
                        label="API Requests"
                        value={searchJob?.requestCount || 0}
                      />

                      <Stat
                        label="Vehicles Missing"
                        value={searchJob?.missingCount || 0}
                      />
                    </div>

                    <div
                      style={{
                        marginTop: "14px",

                        padding: "10px 12px",

                        background: "#ffffff",

                        border: "1px solid #e3e3e3",

                        borderRadius: "8px",

                        fontSize: "13px",

                        color:
                          searchJob?.status === "failed"
                            ? "#8a2e1b"
                            : "#616161",
                      }}
                    >
                      {searchJob?.error ||
                        searchJob?.message ||
                        "Preparing search..."}
                    </div>

                    <SearchQueryLogs logs={searchLogs} />
                  </div>
                )}
              </s-section>
            )}
          </>
        )}

        {searchMode === "manual" && searchJob?.status === "completed" && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
              gap: "12px",
            }}
          >
            <StatCard
              label="Matching Pages"
              value={searchJob.pagesFound || 0}
            />
            <StatCard
              label="Pages Checked"
              value={searchJob.currentYearTotal || 0}
            />
            <StatCard
              label="API Requests"
              value={searchJob.requestCount || 0}
            />
            <StatCard
              label="Search Scope"
              value={
                searchJob.filters?.year || searchJob.filters?.make || "Custom"
              }
            />
          </div>
        )}

        {/* =================================================
            JSON SUMMARY
        ================================================= */}

        {searchMode === "json" && searchJob?.status === "completed" && (
          <div
            style={{
              display: "grid",

              gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",

              gap: "12px",
            }}
          >
            <StatCard label="JSON Vehicles" value={searchJob.totalRecords} />

            <StatCard
              label="Shopify Pages Found"
              value={searchJob.pagesFound}
            />

            <StatCard
              label="Vehicles Not Found"
              value={searchJob.missingCount}
            />

            <StatCard label="API Requests" value={searchJob.requestCount} />
          </div>
        )}

        {/* =================================================
            STEP 2 SELECT RESULTS
        ================================================= */}

        {canShowResults && !isSearching && !jsonBusy && step === "select" && (
          <s-section>
            <div
              style={{
                display: "flex",

                justifyContent: "space-between",

                gap: "12px",

                alignItems: "center",

                flexWrap: "wrap",

                marginBottom: "14px",
              }}
            >
              <div>
                <strong>Select Matching Pages</strong>

                <div
                  style={{
                    marginTop: "4px",

                    color: "#616161",

                    fontSize: "13px",
                  }}
                >
                  {resultPages.length} matching page
                  {resultPages.length === 1 ? "" : "s"}
                </div>
              </div>

              <div
                style={{
                  display: "flex",

                  gap: "8px",
                }}
              >
                <button
                  type="button"

                  onClick={startNewSearch}

                  style={secondaryButton}
                >
                  Change Search
                </button>

                {resultPages.length > 0 && (
                  <button
                    type="button"

                    onClick={toggleAll}

                    style={primaryButton}
                  >
                    {allSelected ? "Deselect All" : "Select All"}
                  </button>
                )}
              </div>
            </div>

            {resultPages.length > 0 ? (
              <>
                <div
                  style={{
                    overflowX: "auto",

                    border: "1px solid #e3e3e3",

                    borderRadius: "10px",
                  }}
                >
                  <table
                    style={{
                      width: "100%",

                      borderCollapse: "collapse",
                    }}
                  >
                    <thead>
                      <tr>
                        <th style={headerStyle}>Select</th>

                        <th align="left" style={headerStyle}>
                          Page
                        </th>

                        <th align="left" style={headerStyle}>
                          Year
                        </th>

                        <th align="left" style={headerStyle}>
                          Make
                        </th>

                        <th align="left" style={headerStyle}>
                          Model
                        </th>

                        <th align="left" style={headerStyle}>
                          Trim
                        </th>

                        <th align="left" style={headerStyle}>
                          Product
                        </th>

                        <th align="left" style={headerStyle}>
                          Status
                        </th>
                      </tr>
                    </thead>

                    <tbody>
                      {resultPages.map((page) => (
                        <tr key={page.id}>
                          <td style={cellStyle}>
                            <input
                              type="checkbox"

                              aria-label={`Select ${page.title}`}

                              checked={selectedIds.has(page.id)}

                              onChange={() => togglePage(page.id)}
                            />
                          </td>

                          <td style={cellStyle}>
                            <strong>{page.title}</strong>

                            <div
                              style={{
                                marginTop: "4px",

                                color: "#616161",

                                fontSize: "12px",
                              }}
                            >
                              {page.handle}
                            </div>
                          </td>

                          <td style={cellStyle}>{page.year || "—"}</td>

                          <td style={cellStyle}>{page.make || "—"}</td>

                          <td style={cellStyle}>{page.model || "—"}</td>

                          <td style={cellStyle}>{page.trim || "—"}</td>

                          <td style={cellStyle}>
                            {page.productHandle ||
                              page.sourceProductHandle ||
                              "—"}
                          </td>

                          <td style={cellStyle}>
                            {page.isPublished ? "Published" : "Draft"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div
                  style={{
                    marginTop: "16px",

                    display: "flex",

                    justifyContent: "space-between",

                    alignItems: "center",

                    gap: "12px",
                  }}
                >
                  <span>{selectedIds.size} selected</span>

                  <button
                    type="button"

                    disabled={selectedIds.size === 0}

                    onClick={() => setStep("action")}

                    style={{
                      ...primaryButton,

                      background:
                        selectedIds.size === 0 ? "#b5b5b5" : "#303030",
                    }}
                  >
                    Continue with {selectedIds.size} selected
                  </button>
                </div>
              </>
            ) : (
              <div
                style={{
                  padding: "24px",

                  textAlign: "center",

                  border: "1px dashed #c9c9c9",

                  borderRadius: "10px",

                  color: "#616161",
                }}
              >
                No matching YMMT pages found.
              </div>
            )}
          </s-section>
        )}

        {/* =================================================
            STEP 3 ACTION
        ================================================= */}

        {canShowResults && step === "action" && (
          <s-section>
            <strong>Choose Action</strong>

            <div
              style={{
                marginTop: "6px",

                marginBottom: "16px",

                color: "#616161",
              }}
            >
              {selectedIds.size} page
              {selectedIds.size === 1 ? "" : "s"} selected
            </div>

            <div
              style={{
                display: "grid",

                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",

                gap: "12px",
              }}
            >
              <ActionCard
                selected={selectedAction === "update-product"}

                title="Update Product Handle"

                description="Update the product handle and related YMMT metafields."

                onClick={() => setSelectedAction("update-product")}
              />

              <ActionCard
                selected={selectedAction === "update-content"}

                title="Update Page Content"

                description="Correct the vehicle metafield and script using your uploaded JSON."

                onClick={() => setSelectedAction("update-content")}
              />

              <ActionCard
                selected={false}
                title="Scan Pages"
                description="Scan YMMT pages and export pages with missing or incorrect values."
                onClick={() => { navigate("/app/scan-pages"); }}
              />

              <ActionCard
                selected={selectedAction === "delete"}

                danger

                title="Delete Pages"

                description="Delete selected Shopify pages after confirmation."

                onClick={() => setSelectedAction("delete")}
              />
            </div>

            <div
              style={{
                marginTop: "18px",

                display: "flex",

                justifyContent: "space-between",
              }}
            >
              <button
                type="button"

                onClick={() => {
                  setSelectedAction("");

                  setStep("select");
                }}

                style={secondaryButton}
              >
                Back
              </button>

              <button
                type="button"

                disabled={!selectedAction}

                onClick={() => setStep("review")}

                style={{
                  ...primaryButton,

                  background: selectedAction ? "#303030" : "#b5b5b5",
                }}
              >
                Continue
              </button>
            </div>
          </s-section>
        )}

        {/* =================================================
            STEP 4 REVIEW
        ================================================= */}

        {canShowResults && step === "review" && (
          <s-section>
            <strong>Review Changes</strong>

            <div
              style={{
                marginTop: "5px",

                marginBottom: "16px",

                color: "#616161",
              }}
            >
              {selectedIds.size} pages selected
            </div>

            {selectedAction === "update-product" && (
              <div
                style={{
                  marginBottom: "16px",
                }}
              >
                <strong>New Product Handle</strong>

                <input
                  type="text"

                  value={productHandle}

                  onChange={(event) => setProductHandle(event.target.value)}

                  placeholder="e.g. triquilt-seat-covers"

                  style={{
                    ...inputStyle,

                    marginTop: "10px",
                  }}
                />
              </div>
            )}

            {selectedAction === "update-content" && (
              <div
                style={{
                  marginBottom: "16px",

                  padding: "14px",

                  background: "#f8f8f8",

                  border: "1px solid #d8d8d8",

                  borderRadius: "10px",
                }}
              >
                {jsonSourceId ? "The vehicle metafield and page script will use the corrected values from your uploaded JSON. Other page HTML and product links will be preserved." : "Search using your corrected JSON before updating content. The existing page values will not be used as the correction source."}
              </div>
            )}

            {selectedAction === "delete" && (
              <div
                style={{
                  marginBottom: "16px",

                  padding: "14px",

                  background: "#fff8f7",

                  border: "1px solid #e6b9b3",

                  borderRadius: "10px",
                }}
              >
                <strong>Delete {selectedIds.size} pages</strong>

                <input
                  type="text"

                  value={deleteConfirmation}

                  onChange={(event) =>
                    setDeleteConfirmation(event.target.value)
                  }

                  placeholder={`Type DELETE ${selectedIds.size} PAGES`}

                  style={{
                    ...inputStyle,

                    marginTop: "12px",
                  }}
                />
              </div>
            )}

            <SelectedPagesTable
              pages={resultPages}

              selectedIds={selectedIds}
            />

            <Form method="post">
              <input type="hidden" name="jsonSourceId" value={jsonSourceId} />
              {[...selectedIds].map((pageId) => (
                <input
                  key={pageId}

                  type="hidden"

                  name="pageIds"

                  value={pageId}
                />
              ))}

              <input
                type="hidden"

                name="intent"

                value={selectedAction}
              />

              {selectedAction === "update-product" && (
                <input
                  type="hidden"

                  name="productHandle"

                  value={productHandle}
                />
              )}

              <div
                style={{
                  marginTop: "16px",

                  display: "flex",

                  justifyContent: "space-between",

                  gap: "10px",
                }}
              >
                <button
                  type="button"

                  disabled={isSubmitting}

                  onClick={() => setStep("action")}

                  style={secondaryButton}
                >
                  Back
                </button>

                <button
                  type="submit"

                  disabled={
                    isSubmitting ||
                    (selectedAction === "update-content" && !jsonSourceId) ||
                    (selectedAction === "update-product" &&
                      !productHandle.trim()) ||
                    (selectedAction === "delete" &&
                      deleteConfirmation !== `DELETE ${selectedIds.size} PAGES`)
                  }

                  style={{
                    ...primaryButton,

                    background:
                      selectedAction === "delete"
                        ? "#8a2e1b"
                        : isSubmitting
                          ? "#8c8c8c"
                          : "#303030",
                  }}
                >
                  {isSubmitting
                    ? "Processing..."
                    : selectedAction === "delete"
                      ? `Delete ${selectedIds.size} Pages`
                      : selectedAction === "update-content"
                        ? "Confirm Content Update"
                        : "Confirm Product Update"}
                </button>
              </div>
            </Form>
          </s-section>
        )}

        {/* =================================================
            OPERATION LOGS
        ================================================= */}

        {shouldShowLogs && (
          <s-section>
            <div
              style={{
                display: "flex",

                justifyContent: "space-between",

                marginBottom: "10px",
              }}
            >
              <strong>Operation Logs</strong>

              {isSubmitting && <span>Processing...</span>}
            </div>

            <div
              style={{
                background: "#151515",

                color: "#f2f2f2",

                borderRadius: "10px",

                maxHeight: "360px",

                overflowY: "auto",

                fontFamily: "monospace",
              }}
            >
              {actionLogs.map((log, index) => (
                <div
                  key={index}

                  style={{
                    padding: "9px 12px",

                    borderBottom: "1px solid #2b2b2b",

                    color: log.startsWith("[FAILED]")
                      ? "#ff8a7a"
                      : log.startsWith("[SUCCESS]")
                        ? "#6fdc8c"
                        : "#9ecbff",
                  }}
                >
                  {log}
                </div>
              ))}
            </div>
          </s-section>
        )}

        {/* =================================================
            ERRORS
        ================================================= */}

        {actionData?.error && (
          <div
            style={{
              padding: "14px",

              background: "#fff4f4",

              border: "1px solid #f1b8b8",

              borderRadius: "10px",
            }}
          >
            {actionData.error}
          </div>
        )}

        {searchJob?.status === "failed" && (
          <div
            style={{
              padding: "14px",

              background: "#fff4f4",

              border: "1px solid #f1b8b8",

              borderRadius: "10px",
            }}
          >
            Search failed: {searchJob.error || "Unknown search error."}
          </div>
        )}

        {/* =================================================
            SUCCESS
        ================================================= */}

        {actionData?.success &&
          [
            "update-product",
            "update-content",
            "delete",
            "rollback-session",
          ].includes(actionData.intent) && (
            <div
              style={{
                padding: "14px",

                background: "#f1fff2",

                border: "1px solid #b7ddb9",

                borderRadius: "10px",
              }}
            >
              {actionData.intent === "update-product" && (
                <>
                  Product handles updated: <strong>{actionData.updated}</strong>
                  {" · "}
                  Failed: <strong>{actionData.failed}</strong>
                </>
              )}

              {actionData.intent === "update-content" && (
                <>
                  Page content updated: <strong>{actionData.updated}</strong>
                  {" · "}
                  Failed: <strong>{actionData.failed}</strong>
                </>
              )}

              {actionData.intent === "delete" && (
                <>
                  Deleted: <strong>{actionData.deleted}</strong>
                  {" · "}
                  Failed: <strong>{actionData.failed}</strong>
                </>
              )}

              {actionData.intent === "rollback-session" && (
                <>
                  Rollback completed. Restored:{" "}
                  <strong>{actionData.restored}</strong>
                  {" · "}
                  Failed: <strong>{actionData.failed}</strong>
                </>
              )}
            </div>
          )}

        {/* =================================================
            RECENT CHANGE SESSIONS
        ================================================= */}

        <s-section>
          <strong>Recent Change Sessions</strong>

          {recentSessions.length > 0 ? (
            <div
              style={{
                marginTop: "12px",

                overflowX: "auto",

                border: "1px solid #e3e3e3",

                borderRadius: "10px",
              }}
            >
              <table
                style={{
                  width: "100%",

                  borderCollapse: "collapse",
                }}
              >
                <thead>
                  <tr>
                    <th align="left" style={headerStyle}>
                      Date
                    </th>

                    <th align="left" style={headerStyle}>
                      Action
                    </th>

                    <th style={headerStyle}>Pages</th>

                    <th style={headerStyle}>Success</th>

                    <th style={headerStyle}>Failed</th>

                    <th style={headerStyle}>Status</th>

                    <th style={headerStyle}>Actions</th>
                  </tr>
                </thead>

                <tbody>
                  {recentSessions.map((session) => (
                    <tr key={session.id}>
                      <td style={cellStyle}>
                        {new Date(session.createdAt).toLocaleString()}
                      </td>

                      <td style={cellStyle}>{session.actionType}</td>

                      <td style={cellStyle}>{session.totalPages}</td>

                      <td style={cellStyle}>{session.successCount}</td>

                      <td style={cellStyle}>{session.failedCount}</td>

                      <td style={cellStyle}>{session.status}</td>

                      <td style={cellStyle}>
                        <Link to={`/app/manage?sessionId=${session.id}`}>
                          View Changes
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <s-paragraph>No change sessions recorded yet.</s-paragraph>
          )}
        </s-section>

        {/* =================================================
            SESSION DETAIL
        ================================================= */}

        {selectedSession && (
          <s-section>
            <div
              style={{
                display: "flex",

                justifyContent: "space-between",

                alignItems: "center",

                gap: "12px",

                marginBottom: "12px",
              }}
            >
              <div>
                <strong>Session Details</strong>

                <div>
                  {selectedSession.actionType} ·{" "}
                  {new Date(selectedSession.createdAt).toLocaleString()}
                </div>
              </div>

              <div
                style={{
                  display: "flex",

                  gap: "10px",
                }}
              >
                {!selectedSession.rolledBackAt && (
                  <Form method="post">
                    <input
                      type="hidden"
                      name="intent"
                      value="rollback-session"
                    />

                    <input
                      type="hidden"
                      name="sessionId"
                      value={selectedSession.id}
                    />

                    <button
                      type="submit"

                      onClick={(event) => {
                        if (
                          !window.confirm(
                            "Rollback all reversible changes from this session?",
                          )
                        ) {
                          event.preventDefault();
                        }
                      }}

                      style={secondaryButton}
                    >
                      Rollback Session
                    </button>
                  </Form>
                )}

                <Link to="/app/manage">Close</Link>
              </div>
            </div>

            <div
              style={{
                overflowX: "auto",

                border: "1px solid #e3e3e3",

                borderRadius: "10px",
              }}
            >
              <table
                style={{
                  width: "100%",

                  borderCollapse: "collapse",
                }}
              >
                <thead>
                  <tr>
                    <th align="left" style={headerStyle}>
                      Page
                    </th>

                    <th align="left" style={headerStyle}>
                      Action
                    </th>

                    <th align="left" style={headerStyle}>
                      Status
                    </th>

                    <th align="left" style={headerStyle}>
                      Rollback
                    </th>
                  </tr>
                </thead>

                <tbody>
                  {selectedSession.changes.map((change) => (
                    <tr key={change.id}>
                      <td style={cellStyle}>
                        <code>{change.handle}</code>
                      </td>

                      <td style={cellStyle}>{change.action}</td>

                      <td style={cellStyle}>{change.status}</td>

                      <td style={cellStyle}>
                        {change.rolledBackAt
                          ? "Rolled back"
                          : "Not rolled back"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </s-section>
        )}
      </div>
    </s-page>
  );
}

/* =========================================================
   SMALL UI COMPONENTS
========================================================= */

function SearchQueryLogs({ logs = [] }) {
  if (!logs.length) {
    return null;
  }

  return (
    <div
      style={{
        marginTop: "14px",
        background: "#151515",
        color: "#f2f2f2",
        borderRadius: "10px",
        border: "1px solid #2c2c2c",
        maxHeight: "260px",
        overflowY: "auto",
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        fontSize: "12px",
      }}
    >
      {logs.map((log, index) => (
        <div
          key={`${index}-${log}`}
          style={{
            padding: "8px 11px",
            borderBottom: "1px solid #2b2b2b",
            lineHeight: "1.5",
            color:
              log.includes("failed") || log.includes("FAILED")
                ? "#ff8a7a"
                : log.includes("completed") || log.includes("DONE")
                  ? "#6fdc8c"
                  : "#9ecbff",
          }}
        >
          {log}
        </div>
      ))}
    </div>
  );
}

function SearchProgressPanel({ searchJob, searchLogs, mode }) {
  const isFinished = ["completed", "failed"].includes(searchJob?.status);

  return (
    <div
      style={{
        marginTop: "16px",
        padding: "18px",
        border: "1px solid #e3e3e3",
        borderRadius: "12px",
        background: "#fafafa",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "12px",
        }}
      >
        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          {!isFinished && <Spinner />}
          <strong>
            {searchJob?.status === "completed"
              ? "Search Completed"
              : searchJob?.status === "failed"
                ? "Search Failed"
                : mode === "manual"
                  ? "Searching Shopify Pages"
                  : "Searching JSON Vehicles"}
          </strong>
        </div>

        <strong>{searchJob?.progress ?? 0}%</strong>
      </div>

      <div
        style={{
          width: "100%",
          height: "10px",
          marginTop: "12px",
          background: "#e3e3e3",
          borderRadius: "999px",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${searchJob?.progress ?? 0}%`,
            height: "100%",
            background: "#303030",
            transition: "width 0.3s ease",
          }}
        />
      </div>

      <div
        style={{
          marginTop: "16px",
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
          gap: "12px",
        }}
      >
        <Stat
          label={mode === "manual" ? "Search Scope" : "Current Year"}
          value={
            mode === "manual"
              ? searchJob?.currentYear || "All"
              : searchJob?.currentYear || "Preparing..."
          }
        />
        <Stat
          label={mode === "manual" ? "Pages Checked" : "Vehicles Found"}
          value={
            mode === "manual"
              ? searchJob?.currentYearTotal || 0
              : `${searchJob?.currentYearFound || 0} / ${
                  searchJob?.currentYearTotal || 0
                }`
          }
        />
        <Stat label="Shopify Pages" value={searchJob?.pagesFound || 0} />
        <Stat label="API Requests" value={searchJob?.requestCount || 0} />
      </div>

      <div
        style={{
          marginTop: "14px",
          padding: "10px 12px",
          background: "#ffffff",
          border: "1px solid #e3e3e3",
          borderRadius: "8px",
          fontSize: "13px",
          color: searchJob?.status === "failed" ? "#8a2e1b" : "#616161",
        }}
      >
        {searchJob?.error || searchJob?.message || "Preparing search..."}
      </div>

      <SearchQueryLogs logs={searchLogs} />
    </div>
  );
}

function Spinner() {
  return (
    <span
      style={{
        width: "18px",

        height: "18px",

        minWidth: "18px",

        display: "inline-block",

        border: "2px solid #d0d0d0",

        borderTopColor: "#303030",

        borderRadius: "50%",

        animation: "ymmt-spin 0.8s linear infinite",
      }}
    />
  );
}

function Stat({ label, value }) {
  return (
    <div>
      <div
        style={{
          fontSize: "12px",

          color: "#616161",

          marginBottom: "3px",
        }}
      >
        {label}
      </div>

      <strong>{value}</strong>
    </div>
  );
}

function StatCard({ label, value }) {
  return (
    <div
      style={{
        padding: "16px",

        border: "1px solid #e3e3e3",

        borderRadius: "12px",

        background: "#ffffff",
      }}
    >
      <div
        style={{
          color: "#616161",

          fontSize: "13px",
        }}
      >
        {label}
      </div>

      <div
        style={{
          marginTop: "6px",

          fontSize: "26px",

          fontWeight: "700",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function ActionCard({ title, description, selected, danger = false, onClick }) {
  return (
    <button
      type="button"

      onClick={onClick}

      style={{
        padding: "18px",

        textAlign: "left",

        borderRadius: "10px",

        background: danger ? "#fff8f7" : "#ffffff",

        border: selected
          ? danger
            ? "2px solid #8a2e1b"
            : "2px solid #303030"
          : danger
            ? "1px solid #e6b9b3"
            : "1px solid #d8d8d8",

        cursor: "pointer",
      }}
    >
      <strong>{title}</strong>

      <div
        style={{
          marginTop: "6px",

          color: "#616161",

          fontSize: "13px",

          lineHeight: "1.5",
        }}
      >
        {description}
      </div>
    </button>
  );
}

function SelectedPagesTable({ pages, selectedIds }) {
  const selectedPages = pages.filter((page) => selectedIds.has(page.id));

  return (
    <div
      style={{
        overflowX: "auto",

        border: "1px solid #e3e3e3",

        borderRadius: "10px",

        marginBottom: "16px",
      }}
    >
      <table
        style={{
          width: "100%",

          borderCollapse: "collapse",
        }}
      >
        <thead>
          <tr>
            <th align="left" style={headerStyle}>
              Page
            </th>

            <th align="left" style={headerStyle}>
              Vehicle
            </th>

            <th align="left" style={headerStyle}>
              Product
            </th>
          </tr>
        </thead>

        <tbody>
          {selectedPages.map((page) => (
            <tr key={page.id}>
              <td style={cellStyle}>
                <strong>{page.title}</strong>

                <div
                  style={{
                    fontSize: "12px",

                    color: "#616161",
                  }}
                >
                  {page.handle}
                </div>
              </td>

              <td style={cellStyle}>
                {[page.year, page.make, page.model, page.trim]
                  .filter(Boolean)
                  .join(" ") || "—"}
              </td>

              <td style={cellStyle}>
                {page.productHandle || page.sourceProductHandle || "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
