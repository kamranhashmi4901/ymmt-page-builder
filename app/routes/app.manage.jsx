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
  searchYMMTPages,
  updateYMMTPage,
} from "../lib/shopify-manage-pages.server";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const url = new URL(request.url);

  const search = url.searchParams.get("search")?.trim() || "";

  const pages = await searchYMMTPages(admin, search);

  return {
    pages,
    search,
  };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const formData = await request.formData();

  const intent = String(formData.get("intent") || "");

  const pageIds = formData.getAll("pageIds").map(String);

  if (!pageIds.length) {
    return {
      success: false,
      error: "Please select at least one page.",
    };
  }

  const results = [];

  if (intent === "delete") {
    const pageMeta = new Map(
      String(formData.get("pageMeta") || "[]") &&
        JSON.parse(String(formData.get("pageMeta") || "[]")).map((page) => [
          page.id,
          page,
        ]),
    );

    for (const pageId of pageIds) {
      const meta = pageMeta.get(pageId) || {};

      try {
        await deleteShopifyPage(admin, pageId);

        results.push({
          pageId,
          title: meta.title || "",
          handle: meta.handle || "",
          status: "deleted",
          message: "Page deleted successfully.",
        });
      } catch (error) {
        results.push({
          pageId,
          title: meta.title || "",
          handle: meta.handle || "",
          status: "failed",
          message: error.message || "Unable to delete page.",
        });
      }
    }

    return {
      success: true,
      intent,
      total: pageIds.length,

      deleted: results.filter((result) => result.status === "deleted").length,

      failed: results.filter((result) => result.status === "failed").length,

      results,
    };
  }

  if (intent === "update") {
    const productHandle = String(formData.get("productHandle") || "")
      .trim()
      .toLowerCase();

    if (productHandle && !/^[a-z0-9-]+$/.test(productHandle)) {
      return {
        success: false,
        error:
          "Product handle can only contain lowercase letters, numbers, and hyphens.",
      };
    }

    for (const pageId of pageIds) {
      try {
        await updateYMMTPage(admin, {
          pageId,
          productHandle,
        });

        results.push({
          pageId,
          status: "updated",
        });
      } catch (error) {
        results.push({
          pageId,
          status: "failed",
          message: error.message || "Unable to update page.",
        });
      }
    }

    return {
      success: true,
      intent,
      updated: results.filter((result) => result.status === "updated").length,
      failed: results.filter((result) => result.status === "failed").length,
      results,
    };
  }

  return {
    success: false,
    error: "Unknown manage action.",
  };
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
  const { pages, search } = useLoaderData();

  const actionData = useActionData();

  const navigation = useNavigation();

  const busy = navigation.state === "submitting";

  const [selectedIds, setSelectedIds] = useState(new Set());

  const allSelected =
    pages.length > 0 && pages.every((page) => selectedIds.has(page.id));

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
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "18px",
        }}
      >
        <s-section>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "7px",
            }}
          >
            <s-icon type="search" />
            <strong>Search Existing Pages</strong>
          </span>
          <s-paragraph>
            Search Shopify YMMT pages by page title or handle, then select pages
            for bulk updates or deletion.
          </s-paragraph>

          <Form method="get">
            <div
              style={{
                marginTop: "16px",
                display: "flex",
                gap: "10px",
                flexWrap: "wrap",
              }}
            >
              <input
                type="text"
                name="search"
                defaultValue={search}
                placeholder="e.g. 2027-toyota or triquilt-seat-covers"
                style={{
                  flex: "1 1 360px",
                  padding: "10px 12px",
                  border: "1px solid #c9c9c9",
                  borderRadius: "8px",
                }}
              />

              <button
                type="submit"
                style={{
                  padding: "10px 16px",
                  borderRadius: "8px",
                  border: "none",
                  background: "#303030",
                  color: "#ffffff",
                  fontWeight: "650",
                }}
              >
                Search Pages
              </button>

              {search && (
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
                  Clear
                </Link>
              )}
            </div>
          </Form>
        </s-section>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: "12px",
          }}
        >
          <div
            style={{
              background: "#ffffff",
              border: "1px solid #e3e3e3",
              borderRadius: "12px",
              padding: "16px",
            }}
          >
            <div
              style={{
                color: "#616161",
                fontSize: "13px",
              }}
            >
              Matching Pages
            </div>

            <div
              style={{
                fontSize: "26px",
                fontWeight: "700",
                marginTop: "4px",
              }}
            >
              {pages.length}
            </div>
          </div>

          <div
            style={{
              background: "#ffffff",
              border: "1px solid #e3e3e3",
              borderRadius: "12px",
              padding: "16px",
            }}
          >
            <div
              style={{
                color: "#616161",
                fontSize: "13px",
              }}
            >
              Selected
            </div>

            <div
              style={{
                fontSize: "26px",
                fontWeight: "700",
                marginTop: "4px",
              }}
            >
              {selectedIds.size}
            </div>
          </div>
        </div>

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
            {actionData.intent === "delete" && (
              <>
                Deleted: <strong>{actionData.deleted}</strong>
                {" · "}
                Failed: <strong>{actionData.failed}</strong>
              </>
            )}

            {actionData.intent === "update" && (
              <>
                Updated: <strong>{actionData.updated}</strong>
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

        <Form method="post">
          {[...selectedIds].map((pageId) => (
            <input key={pageId} type="hidden" name="pageIds" value={pageId} />
          ))}
          <input
            type="hidden"
            name="pageMeta"
            value={JSON.stringify(
              pages.map((page) => ({
                id: page.id,
                title: page.title,
                handle: page.handle,
              })),
            )}
          />
          <div
            style={{ display: "flex", flexDirection: "column", gap: "18px" }}
          >
            <s-section>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "7px",
                }}
              >
                <s-icon type="edit" />
                <strong>Bulk Actions</strong>
              </span>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
                  gap: "18px",
                }}
              >
                <div
                  style={{
                    padding: "16px",
                    border: "1px solid #e3e3e3",
                    borderRadius: "12px",
                  }}
                >
                  <strong>Update Selected Pages</strong>

                  <div
                    style={{
                      marginTop: "6px",
                      color: "#616161",
                      fontSize: "13px",
                      lineHeight: "1.5",
                    }}
                  >
                    Reapply the <code>product-ymmt</code> template and
                    optionally update the source product handle.
                  </div>

                  <input
                    type="text"
                    name="productHandle"
                    placeholder="Optional product handle"
                    style={{
                      width: "100%",
                      boxSizing: "border-box",
                      marginTop: "14px",
                      padding: "10px 12px",
                      border: "1px solid #c9c9c9",
                      borderRadius: "8px",
                    }}
                  />

                  <button
                    type="submit"
                    name="intent"
                    value="update"
                    disabled={busy || selectedIds.size === 0}
                    style={{
                      marginTop: "12px",
                      padding: "10px 15px",
                      borderRadius: "8px",
                      border: "none",
                      background:
                        selectedIds.size === 0 || busy ? "#b5b5b5" : "#303030",
                      color: "#ffffff",
                      fontWeight: "650",
                    }}
                  >
                    Update {selectedIds.size} Pages
                  </button>
                </div>

                <div
                  style={{
                    padding: "16px",
                    border: "1px solid #e6b9b3",
                    background: "#fff8f7",
                    borderRadius: "12px",
                  }}
                >
                  <strong>Delete Selected Pages</strong>

                  <div
                    style={{
                      marginTop: "6px",
                      color: "#616161",
                      fontSize: "13px",
                      lineHeight: "1.5",
                    }}
                  >
                    Permanently delete the selected Shopify pages. This cannot
                    be undone.
                  </div>

                  <button
                    type="submit"
                    name="intent"
                    value="delete"
                    disabled={busy || selectedIds.size === 0}
                    onClick={(event) => {
                      if (
                        !window.confirm(
                          `Permanently delete ${selectedIds.size} selected pages?`,
                        )
                      ) {
                        event.preventDefault();
                      }
                    }}
                    style={{
                      marginTop: "16px",
                      padding: "10px 15px",
                      borderRadius: "8px",
                      border: "1px solid #d4a09a",
                      background: "#ffffff",
                      color: "#8a2e1b",
                      fontWeight: "650",
                    }}
                  >
                    Delete {selectedIds.size} Pages
                  </button>
                </div>
              </div>
            </s-section>

            <s-section>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "7px",
                }}
              >
                <s-icon type="page" />
                <strong>Existing YMMT Pages</strong>
              </span>
              {pages.length > 0 ? (
                <>
                  <div
                    style={{
                      marginBottom: "14px",
                      display: "flex",
                      gap: "10px",
                    }}
                  >
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

                    {selectedIds.size > 0 && (
                      <button
                        type="button"
                        onClick={() => setSelectedIds(new Set())}
                        style={{
                          padding: "8px 13px",
                          borderRadius: "8px",
                          border: "1px solid #c9c9c9",
                          background: "#ffffff",
                          fontWeight: "600",
                        }}
                      >
                        Clear Selection
                      </button>
                    )}
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
                          <th style={tableHeaderStyle}>Select</th>

                          <th align="left" style={tableHeaderStyle}>
                            Title
                          </th>

                          <th align="left" style={tableHeaderStyle}>
                            Handle
                          </th>

                          <th align="left" style={tableHeaderStyle}>
                            Product
                          </th>

                          <th align="left" style={tableHeaderStyle}>
                            Template
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
                            </td>

                            <td style={tableCellStyle}>
                              <code>{page.handle}</code>
                            </td>

                            <td style={tableCellStyle}>
                              {page.productHandle || "—"}
                            </td>

                            <td style={tableCellStyle}>
                              {page.templateSuffix || "Default"}
                            </td>

                            <td style={tableCellStyle}>
                              <span
                                style={{
                                  display: "inline-block",
                                  padding: "4px 8px",
                                  borderRadius: "999px",
                                  background: page.isPublished
                                    ? "#eaf7ee"
                                    : "#f1f1f1",
                                  color: page.isPublished
                                    ? "#176b35"
                                    : "#616161",
                                  fontSize: "12px",
                                  fontWeight: "650",
                                }}
                              >
                                {page.isPublished ? "Published" : "Draft"}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : (
                <div
                  style={{
                    padding: "30px",
                    textAlign: "center",
                    color: "#616161",
                    border: "1px dashed #c9c9c9",
                    borderRadius: "10px",
                  }}
                >
                  No YMMT pages found.
                </div>
              )}
            </s-section>
          </div>
        </Form>
      </div>
    </s-page>
  );
}
