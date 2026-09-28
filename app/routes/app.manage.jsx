import { useState } from "react";
import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";

import { authenticate } from "../shopify.server";

import {
  deleteShopifyPage,
  getShopifyPageSnapshot,
  searchYMMTPages,
  updateYMMTProductHandle,
  updateYMMTPageContent,
} from "../lib/shopify-manage-pages.server";

import {
  createActionSession,
  logPageBeforeChange,
  markPageChangeSuccess,
  markPageChangeFailed,
  completeActionSession,
  getRecentActionSessions,
} from "../lib/page-change-log.server";

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

  const pages = hasFilters ? await searchYMMTPages(admin, filters) : [];

  const recentSessions = await getRecentActionSessions(session.shop, 10);

  return {
    pages,
    filters,
    recentSessions,
    hasFilters,
  };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  const shop = session.shop;
  const formData = await request.formData();

  const intent = String(formData.get("intent") || "");
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

  // --------------------------------------------------
  // UPDATE PRODUCT HANDLE
  // --------------------------------------------------

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

  // --------------------------------------------------
  // UPDATE PAGE CONTENT
  // --------------------------------------------------

  if (intent === "update-content") {
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

        await updateYMMTPageContent(admin, pageId);

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

  // --------------------------------------------------
  // DELETE PAGES
  // --------------------------------------------------

  if (intent === "delete") {
    const actionSession = await createActionSession({
      shop,
      actionType: "delete",
      totalPages: pageIds.length,
    });

    for (const pageId of pageIds) {
      let changeLog = null;

      try {
        // Critical: backup complete page BEFORE deleting.
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

const filterInputStyle = {
  width: "100%",
  boxSizing: "border-box",
  padding: "10px 12px",
  border: "1px solid #c9c9c9",
  borderRadius: "8px",
  background: "#ffffff",
};

const tableHeaderStyle = {
  padding: "12px",
  borderBottom: "1px solid #dedede",
  background: "#f7f7f7",
  fontSize: "12px",
  fontWeight: "650",
  whiteSpace: "nowrap",
};

const tableCellStyle = {
  padding: "12px",
  borderBottom: "1px solid #eeeeee",
  verticalAlign: "top",
  fontSize: "13px",
};

export default function ManagePages() {
  const [step, setStep] = useState("select");
  const [selectedAction, setSelectedAction] = useState("");
  const { pages, filters, recentSessions, hasFilters } = useLoaderData();

  const actionData = useActionData();
  const [selectedIds, setSelectedIds] = useState(new Set());

  const [productHandle, setProductHandle] = useState("");
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const navigation = useNavigation();

  const isSearching =
    navigation.state === "loading" &&
    navigation.location?.pathname === "/app/manage";

  const allSelected =
    pages.length > 0 && pages.every((page) => selectedIds.has(page.id));

  const isSubmitting = navigation.state === "submitting";

  const submittingIntent = navigation.formData?.get("intent");
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
  }

  if (actionData?.success) {
    actionData.results?.forEach((result) => {
      if (result.status === "updated" || result.status === "deleted") {
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
    } else {
      setSelectedIds(new Set(pages.map((page) => page.id)));
    }
  };

  return (
    <s-page heading="Manage YMMT Pages">
      <style>
        {`
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
        {/* Step 1 Search Pages  */}
        <s-section>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "7px",
            }}
          >
            <s-icon type="search" />
            <strong>Find YMMT Pages</strong>
          </span>

          <s-paragraph>
            Search and filter existing YMMT pages before selecting pages to
            manage.
          </s-paragraph>

          <Form method="get">
            <div
              style={{
                marginTop: "18px",
                display: "flex",
                flexDirection: "column",
                gap: "14px",
              }}
            >
              {/* General search */}
              <input
                type="text"
                name="search"
                defaultValue={filters.search}
                placeholder="Search by page title or handle"
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "10px 12px",
                  border: "1px solid #c9c9c9",
                  borderRadius: "8px",
                }}
              />

              {/* Vehicle filters */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                  gap: "12px",
                }}
              >
                <input
                  type="text"
                  name="year"
                  defaultValue={filters.year}
                  placeholder="Year"
                  style={filterInputStyle}
                />

                <input
                  type="text"
                  name="make"
                  defaultValue={filters.make}
                  placeholder="Make"
                  style={filterInputStyle}
                />

                <input
                  type="text"
                  name="model"
                  defaultValue={filters.model}
                  placeholder="Model"
                  style={filterInputStyle}
                />

                <input
                  type="text"
                  name="trim"
                  defaultValue={filters.trim}
                  placeholder="Trim"
                  style={filterInputStyle}
                />
              </div>

              {/* YMMT metadata filters */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                  gap: "12px",
                }}
              >
                <input
                  type="text"
                  name="manufacturer"
                  defaultValue={filters.manufacturer}
                  placeholder="Manufacturer"
                  style={filterInputStyle}
                />

                <input
                  type="text"
                  name="compatibility"
                  defaultValue={filters.compatibility}
                  placeholder="Compatibility"
                  style={filterInputStyle}
                />

                <input
                  type="text"
                  name="warning"
                  defaultValue={filters.warning}
                  placeholder="Warning"
                  style={filterInputStyle}
                />

                <input
                  type="text"
                  name="productHandle"
                  defaultValue={filters.productHandle}
                  placeholder="Product handle"
                  style={filterInputStyle}
                />
              </div>

              {/* Status */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(200px, 300px)",
                }}
              >
                <select
                  name="status"
                  defaultValue={filters.status}
                  style={filterInputStyle}
                >
                  <option value="">All statuses</option>
                  <option value="published">Published</option>
                  <option value="draft">Draft</option>
                </select>
              </div>

              {/* Buttons */}
              <div
                style={{
                  display: "flex",
                  gap: "10px",
                  flexWrap: "wrap",
                }}
              >
                <button
                  type="submit"
                  disabled={isSearching}
                  style={{
                    padding: "10px 16px",
                    borderRadius: "8px",
                    border: "none",
                    background: isSearching ? "#8c8c8c" : "#303030",
                    color: "#ffffff",
                    fontWeight: "650",
                    cursor: isSearching ? "wait" : "pointer",
                  }}
                >
                  {isSearching ? "Searching..." : "Search Pages"}
                </button>

                {Object.values(filters).some(Boolean) && (
                  <Link
                    to="/app/manage"
                    style={{
                      padding: "9px 15px",
                      borderRadius: "8px",
                      border: "1px solid #c9c9c9",
                      color: "#303030",
                      textDecoration: "none",
                      fontWeight: "600",
                    }}
                  >
                    Clear Filters
                  </Link>
                )}
              </div>
            </div>
          </Form>
          {isSearching && (
            <div
              style={{
                padding: "18px",
                border: "1px solid #e3e3e3",
                borderRadius: "10px",
                background: "#fafafa",
                display: "flex",
                alignItems: "center",
                gap: "12px",
              }}
            >
              <div
                style={{
                  width: "18px",
                  height: "18px",
                  border: "2px solid #d0d0d0",
                  borderTopColor: "#303030",
                  borderRadius: "50%",
                  animation: "ymmt-spin 0.8s linear infinite",
                }}
              />

              <div>
                <strong>Searching Shopify pages...</strong>
                <div
                  style={{
                    marginTop: "3px",
                    fontSize: "13px",
                    color: "#616161",
                  }}
                >
                  Checking YMMT pages against your selected filters.
                </div>
              </div>
            </div>
          )}
        </s-section>

        {/* Step 2 Select Pages */}
        {hasFilters && !isSearching && step === "select" && (
          <s-section>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "12px",
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
                  {pages.length} matching page{pages.length === 1 ? "" : "s"}
                </div>
              </div>

              {pages.length > 0 && (
                <button
                  type="button"
                  onClick={toggleAll}
                  style={{
                    padding: "8px 13px",
                    borderRadius: "8px",
                    border: "1px solid #c9c9c9",
                    background: "#ffffff",
                    fontWeight: "600",
                  }}
                >
                  {allSelected ? "Deselect All" : "Select All"}
                </button>
              )}
            </div>

            {pages.length > 0 ? (
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
                        <th style={tableHeaderStyle}>Select</th>
                        <th align="left" style={tableHeaderStyle}>
                          Title
                        </th>
                        <th align="left" style={tableHeaderStyle}>
                          Year
                        </th>
                        <th align="left" style={tableHeaderStyle}>
                          Make
                        </th>
                        <th align="left" style={tableHeaderStyle}>
                          Model
                        </th>
                        <th align="left" style={tableHeaderStyle}>
                          Trim
                        </th>
                        <th align="left" style={tableHeaderStyle}>
                          Product
                        </th>
                        <th align="left" style={tableHeaderStyle}>
                          Status
                        </th>
                      </tr>
                    </thead>

                    <tbody>
                      {pages.map((page) => (
                        <tr key={page.id}>
                          <td style={tableCellStyle}>
                            <input
                              type="checkbox"
                              checked={selectedIds.has(page.id)}
                              onChange={() => togglePage(page.id)}
                            />
                          </td>

                          <td style={tableCellStyle}>
                            <strong>{page.title}</strong>
                            <div
                              style={{
                                marginTop: "4px",
                                fontSize: "12px",
                                color: "#616161",
                              }}
                            >
                              {page.handle}
                            </div>
                          </td>

                          <td style={tableCellStyle}>{page.year || "—"}</td>
                          <td style={tableCellStyle}>{page.make || "—"}</td>
                          <td style={tableCellStyle}>{page.model || "—"}</td>
                          <td style={tableCellStyle}>{page.trim || "—"}</td>

                          <td style={tableCellStyle}>
                            {page.productHandle || "—"}
                          </td>

                          <td style={tableCellStyle}>
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
                    flexWrap: "wrap",
                  }}
                >
                  <div
                    style={{
                      fontSize: "13px",
                      color: "#616161",
                    }}
                  >
                    {selectedIds.size} selected
                  </div>

                  <button
                    type="button"
                    disabled={selectedIds.size === 0}
                    style={{
                      padding: "10px 16px",
                      borderRadius: "8px",
                      border: "none",
                      background: isSearching ? "#8c8c8c" : "#303030",
                      color: "#ffffff",
                      fontWeight: "650",
                      cursor: isSearching ? "wait" : "pointer",
                    }}
                    onClick={() => setStep("action")}
                  >
                    Continue with {selectedIds.size} selected
                  </button>
                </div>
              </>
            ) : (
              <div
                style={{
                  padding: "24px",
                  border: "1px dashed #c9c9c9",
                  borderRadius: "10px",
                  textAlign: "center",
                  color: "#616161",
                }}
              >
                No matching YMMT pages found.
              </div>
            )}
          </s-section>
        )}

        {/* Step 3 choose action */}
        {hasFilters && step === "action" && (
          <s-section>
            <div style={{ marginBottom: "16px" }}>
              <strong>Choose Action</strong>

              <div
                style={{
                  marginTop: "4px",
                  color: "#616161",
                  fontSize: "13px",
                }}
              >
                {selectedIds.size} page{selectedIds.size === 1 ? "" : "s"}{" "}
                selected
              </div>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
                gap: "14px",
              }}
            >
              {/* 1. Update product handle */}
              <button
                type="button"
                onClick={() => setSelectedAction("update-product")}
                style={{
                  padding: "18px",
                  textAlign: "left",
                  borderRadius: "10px",
                  border:
                    selectedAction === "update-product"
                      ? "2px solid #303030"
                      : "1px solid #d8d8d8",
                  background: "#ffffff",
                }}
              >
                <strong>Update Product Handle</strong>

                <div
                  style={{
                    marginTop: "6px",
                    color: "#616161",
                    fontSize: "13px",
                  }}
                >
                  Update the product handle and related YMMT product metafields
                  for the selected pages.
                </div>
              </button>

              {/* 2. Update page content */}
              <button
                type="button"
                onClick={() => setSelectedAction("update-content")}
                style={{
                  padding: "18px",
                  textAlign: "left",
                  borderRadius: "10px",
                  border:
                    selectedAction === "update-content"
                      ? "2px solid #303030"
                      : "1px solid #d8d8d8",
                  background: "#ffffff",
                }}
              >
                <strong>Update Page Content</strong>

                <div
                  style={{
                    marginTop: "6px",
                    color: "#616161",
                    fontSize: "13px",
                  }}
                >
                  Rebuild the selected page content using its YMMT data and the
                  same vehicle script used when creating new pages.
                </div>
              </button>

              {/* 3. Delete */}
              <button
                type="button"
                onClick={() => setSelectedAction("delete")}
                style={{
                  padding: "18px",
                  textAlign: "left",
                  borderRadius: "10px",
                  border:
                    selectedAction === "delete"
                      ? "2px solid #8a2e1b"
                      : "1px solid #e6b9b3",
                  background: "#fff8f7",
                }}
              >
                <strong>Delete Pages</strong>

                <div
                  style={{
                    marginTop: "6px",
                    color: "#616161",
                    fontSize: "13px",
                  }}
                >
                  Delete the selected Shopify pages after review and
                  confirmation.
                </div>
              </button>
            </div>

            <div
              style={{
                marginTop: "18px",
                display: "flex",
                justifyContent: "space-between",
                gap: "10px",
              }}
            >
              <button
                type="button"
                onClick={() => {
                  setSelectedAction("");
                  setStep("select");
                }}
                style={{
                  padding: "9px 15px",
                  borderRadius: "8px",
                  border: "1px solid #c9c9c9",
                  color: "#303030",
                  textDecoration: "none",
                  fontWeight: "600",
                }}
              >
                Back
              </button>

              <button
                type="button"
                disabled={!selectedAction}
                onClick={() => setStep("review")}
                style={{
                  padding: "10px 16px",
                  borderRadius: "8px",
                  border: "none",
                  background: selectedAction ? "#303030" : "#b5b5b5",
                  color: "#ffffff",
                  fontWeight: "650",
                }}
              >
                Continue
              </button>
            </div>
          </s-section>
        )}

        {/* Step 4 Review Selected pages and Confirm */}
        {hasFilters && step === "review" && (
          <s-section>
            <div style={{ marginBottom: "16px" }}>
              <strong>Review Changes</strong>

              <div
                style={{
                  marginTop: "4px",
                  color: "#616161",
                  fontSize: "13px",
                }}
              >
                {selectedIds.size} page{selectedIds.size === 1 ? "" : "s"}{" "}
                selected
              </div>
            </div>

            {/* UPDATE PRODUCT HANDLE */}
            {selectedAction === "update-product" && (
              <div style={{ marginBottom: "18px" }}>
                <strong>Update Product Handle</strong>

                <div
                  style={{
                    marginTop: "6px",
                    marginBottom: "12px",
                    color: "#616161",
                    fontSize: "13px",
                  }}
                >
                  This will update the product handle metafields on all selected
                  pages.
                </div>

                <input
                  type="text"
                  value={productHandle}
                  onChange={(event) => setProductHandle(event.target.value)}
                  placeholder="e.g. triquilt-seat-covers"
                  style={filterInputStyle}
                />
              </div>
            )}

            {/* UPDATE CONTENT */}
            {selectedAction === "update-content" && (
              <div
                style={{
                  padding: "14px",
                  marginBottom: "18px",
                  border: "1px solid #d8d8d8",
                  borderRadius: "10px",
                  background: "#f8f8f8",
                }}
              >
                <strong>Update Page Content</strong>

                <div
                  style={{
                    marginTop: "6px",
                    color: "#616161",
                    fontSize: "13px",
                    lineHeight: "1.5",
                  }}
                >
                  The page body will be rebuilt using each page&apos;s
                  <code> ymmt.vehicle </code>
                  data and the current YMMT session-storage script.
                </div>
              </div>
            )}

            {/* DELETE */}
            {selectedAction === "delete" && (
              <div
                style={{
                  padding: "14px",
                  marginBottom: "18px",
                  border: "1px solid #e6b9b3",
                  borderRadius: "10px",
                  background: "#fff8f7",
                }}
              >
                <strong>Delete Pages</strong>

                <div
                  style={{
                    marginTop: "6px",
                    color: "#8a2e1b",
                    fontSize: "13px",
                  }}
                >
                  You are about to delete {selectedIds.size} Shopify page
                  {selectedIds.size === 1 ? "" : "s"}.
                </div>

                <input
                  type="text"
                  value={deleteConfirmation}
                  onChange={(event) =>
                    setDeleteConfirmation(event.target.value)
                  }
                  placeholder={`Type DELETE ${selectedIds.size} PAGES`}
                  style={{
                    ...filterInputStyle,
                    marginTop: "12px",
                  }}
                />
              </div>
            )}

            {/* SELECTED PAGE PREVIEW */}
            <div
              style={{
                overflowX: "auto",
                border: "1px solid #e3e3e3",
                borderRadius: "10px",
                marginBottom: "18px",
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
                    <th align="left" style={tableHeaderStyle}>
                      Page
                    </th>
                    <th align="left" style={tableHeaderStyle}>
                      Vehicle
                    </th>
                    <th align="left" style={tableHeaderStyle}>
                      Product
                    </th>
                  </tr>
                </thead>

                <tbody>
                  {pages
                    .filter((page) => selectedIds.has(page.id))
                    .map((page) => (
                      <tr key={page.id}>
                        <td style={tableCellStyle}>
                          <strong>{page.title}</strong>

                          <div
                            style={{
                              marginTop: "4px",
                              fontSize: "12px",
                              color: "#616161",
                            }}
                          >
                            {page.handle}
                          </div>
                        </td>

                        <td style={tableCellStyle}>
                          {[page.year, page.make, page.model, page.trim]
                            .filter(Boolean)
                            .join(" ") || "—"}
                        </td>

                        <td style={tableCellStyle}>
                          {page.productHandle || "—"}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>

            <Form method="post">
              {[...selectedIds].map((pageId) => (
                <input
                  key={pageId}
                  type="hidden"
                  name="pageIds"
                  value={pageId}
                />
              ))}

              <input type="hidden" name="intent" value={selectedAction} />

              {selectedAction === "update-product" && (
                <input
                  type="hidden"
                  name="productHandle"
                  value={productHandle}
                />
              )}

              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: "10px",
                }}
              >
                <button
                  type="button"
                  onClick={() => setStep("action")}
                  disabled={isSubmitting}
                  style={{
                    padding: "9px 15px",
                    borderRadius: "8px",
                    border: "1px solid #c9c9c9",
                    color: "#303030",
                    textDecoration: "none",
                    fontWeight: "600",
                  }}
                >
                  Back
                </button>

                <button
                  type="submit"
                  disabled={
                    isSubmitting ||
                    (selectedAction === "update-product" &&
                      !productHandle.trim()) ||
                    (selectedAction === "delete" &&
                      deleteConfirmation !== `DELETE ${selectedIds.size} PAGES`)
                  }
                  style={{
                    padding: "10px 16px",
                    borderRadius: "8px",
                    border: "none",
                    background: isSubmitting
                      ? "#8c8c8c"
                      : selectedAction === "delete"
                        ? "#8a2e1b"
                        : "#303030",
                    color: "#ffffff",
                    fontWeight: "650",
                    cursor: isSubmitting ? "wait" : "pointer",
                  }}
                >
                  {isSubmitting && submittingIntent === "update-product"
                    ? "Updating Product Handles..."
                    : isSubmitting && submittingIntent === "update-content"
                      ? "Updating Page Content..."
                      : isSubmitting && submittingIntent === "delete"
                        ? "Deleting Pages..."
                        : selectedAction === "update-product"
                          ? "Confirm Product Update"
                          : selectedAction === "update-content"
                            ? "Confirm Content Update"
                            : selectedAction === "delete"
                              ? `Delete ${selectedIds.size} Pages`
                              : "Confirm"}
                </button>
              </div>
            </Form>
          </s-section>
        )}

        {/* logs */}
        {(isSubmitting || actionData?.success) && (
          <s-section>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginBottom: "12px",
              }}
            >
              <strong>Operation Logs</strong>

              {isSubmitting && (
                <span style={{ fontSize: "13px", color: "#616161" }}>
                  Processing...
                </span>
              )}
            </div>

            <div
              style={{
                background: "#151515",
                color: "#f2f2f2",
                borderRadius: "10px",
                border: "1px solid #2c2c2c",
                maxHeight: "360px",
                overflowY: "auto",
                fontFamily:
                  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                fontSize: "12px",
              }}
            >
              {actionLogs.map((log, index) => {
                const failed = log.startsWith("[FAILED]");
                const success = log.startsWith("[SUCCESS]");

                return (
                  <div
                    key={index}
                    style={{
                      padding: "9px 12px",
                      borderBottom: "1px solid #2b2b2b",
                      lineHeight: "1.5",
                      color: failed
                        ? "#ff8a7a"
                        : success
                          ? "#6fdc8c"
                          : "#f2f2f2",
                    }}
                  >
                    {log}
                  </div>
                );
              })}

              {isSubmitting && (
                <div
                  style={{
                    padding: "9px 12px",
                    color: "#9ecbff",
                  }}
                >
                  Processing Shopify pages...
                </div>
              )}
            </div>
          </s-section>
        )}

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

        {actionData?.success && (
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
          </div>
        )}

        {actionData?.success &&
          actionData.intent === "delete" &&
          actionData.results?.length > 0 && (
            <s-section>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "7px",
                  marginBottom: "14px",
                }}
              >
                <s-icon type="note" />
                <strong>Deletion Logs</strong>
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                  gap: "12px",
                  marginBottom: "16px",
                }}
              >
                <div
                  style={{
                    padding: "14px",
                    border: "1px solid #e3e3e3",
                    borderRadius: "10px",
                    background: "#ffffff",
                  }}
                >
                  <div
                    style={{
                      fontSize: "12px",
                      color: "#616161",
                    }}
                  >
                    Total
                  </div>

                  <div
                    style={{
                      fontSize: "24px",
                      fontWeight: "700",
                      marginTop: "4px",
                    }}
                  >
                    {actionData.total}
                  </div>
                </div>

                <div
                  style={{
                    padding: "14px",
                    border: "1px solid #b7ddb9",
                    borderRadius: "10px",
                    background: "#f1fff2",
                  }}
                >
                  <div
                    style={{
                      fontSize: "12px",
                      color: "#616161",
                    }}
                  >
                    Deleted
                  </div>

                  <div
                    style={{
                      fontSize: "24px",
                      fontWeight: "700",
                      marginTop: "4px",
                      color: "#176b35",
                    }}
                  >
                    {actionData.deleted}
                  </div>
                </div>

                <div
                  style={{
                    padding: "14px",
                    border: "1px solid #f1b8b8",
                    borderRadius: "10px",
                    background: "#fff4f4",
                  }}
                >
                  <div
                    style={{
                      fontSize: "12px",
                      color: "#616161",
                    }}
                  >
                    Failed
                  </div>

                  <div
                    style={{
                      fontSize: "24px",
                      fontWeight: "700",
                      marginTop: "4px",
                      color: "#8a2e1b",
                    }}
                  >
                    {actionData.failed}
                  </div>
                </div>
              </div>

              <div
                style={{
                  background: "#151515",
                  color: "#f2f2f2",
                  borderRadius: "10px",
                  border: "1px solid #2c2c2c",
                  maxHeight: "380px",
                  overflowY: "auto",
                  fontFamily:
                    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                  fontSize: "12px",
                }}
              >
                {actionData.results.map((result, index) => {
                  const success = result.status === "deleted";

                  return (
                    <div
                      key={`${result.pageId}-${index}`}
                      style={{
                        padding: "9px 12px",
                        borderBottom: "1px solid #2b2b2b",
                        lineHeight: "1.5",
                      }}
                    >
                      <strong
                        style={{
                          color: success ? "#6fdc8c" : "#ff8a7a",
                        }}
                      >
                        {success ? "[DELETED]" : "[FAILED]"}
                      </strong>{" "}
                      {result.handle ? (
                        <code
                          style={{
                            color: "#9ecbff",
                          }}
                        >
                          {result.handle}
                        </code>
                      ) : (
                        <code>{result.pageId}</code>
                      )}
                      {result.title && (
                        <>
                          {" — "}
                          {result.title}
                        </>
                      )}
                      {result.message && (
                        <>
                          {" — "}
                          {result.message}
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </s-section>
          )}

        {/* Recent page changes log sessions */}
        <s-section>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: "14px",
            }}
          >
            <strong>Recent Change Sessions</strong>
          </div>

          {recentSessions.length > 0 ? (
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
                    <th align="left" style={tableHeaderStyle}>
                      Date
                    </th>
                    <th align="left" style={tableHeaderStyle}>
                      Action
                    </th>
                    <th align="left" style={tableHeaderStyle}>
                      Pages
                    </th>
                    <th align="left" style={tableHeaderStyle}>
                      Success
                    </th>
                    <th align="left" style={tableHeaderStyle}>
                      Failed
                    </th>
                    <th align="left" style={tableHeaderStyle}>
                      Status
                    </th>
                  </tr>
                </thead>

                <tbody>
                  {recentSessions.map((session) => (
                    <tr key={session.id}>
                      <td style={tableCellStyle}>
                        {new Date(session.createdAt).toLocaleString()}
                      </td>

                      <td style={tableCellStyle}>{session.actionType}</td>

                      <td style={tableCellStyle}>{session.totalPages}</td>

                      <td style={tableCellStyle}>{session.successCount}</td>

                      <td style={tableCellStyle}>{session.failedCount}</td>

                      <td style={tableCellStyle}>{session.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <s-paragraph>No change sessions recorded yet.</s-paragraph>
          )}
        </s-section>
      </div>
    </s-page>
  );
}
