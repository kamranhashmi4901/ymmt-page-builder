import { useEffect, useState } from "react";

import {
  Form,
  Link,
  redirect,
  useLoaderData,
  useNavigation,
} from "react-router";

import db from "../db.server";

import { authenticate } from "../shopify.server";

import {
  getYMMTUpload,
  getFilteredYMMTRecords,
} from "../lib/ymmt-uploads.server";

import { getExistingPageHandles } from "../lib/shopify-pages.server";

import { buildYMMTPageHandle, buildYMMTPageTitle } from "../lib/ymmt-pages";

/* -------------------------------------------------------
   Helpers
------------------------------------------------------- */

function getFiltersFromURL(url) {
  return {
    year: url.searchParams.get("year") || "",
    make: url.searchParams.get("make") || "",
    model: url.searchParams.get("model") || "",
    trim: url.searchParams.get("trim") || "",
    manufacturer: url.searchParams.get("manufacturer") || "",
  };
}

function getFiltersFromForm(formData) {
  return {
    year: String(formData.get("year") || ""),
    make: String(formData.get("make") || ""),
    model: String(formData.get("model") || ""),
    trim: String(formData.get("trim") || ""),
    manufacturer: String(formData.get("manufacturer") || ""),
  };
}

function buildReviewURL({ uploadId, filters, page = 1 }) {
  const params = new URLSearchParams();

  params.set("uploadId", uploadId);

  if (filters.year) {
    params.set("year", filters.year);
  }

  if (filters.make) {
    params.set("make", filters.make);
  }

  if (filters.model) {
    params.set("model", filters.model);
  }

  if (filters.trim) {
    params.set("trim", filters.trim);
  }

  if (filters.manufacturer) {
    params.set("manufacturer", filters.manufacturer);
  }

  params.set("page", String(page));

  return `/app/review?${params.toString()}`;
}

/*
 * Saves only the rows currently visible on the page.
 * Other pages keep their existing selection state.
 */
async function saveCurrentPageSelection({
  uploadId,
  pageIds,
  selectedIds,
  upload,
  admin,
}) {
  if (!pageIds.length) {
    return;
  }

  const records = await db.ymmtRecord.findMany({
    where: {
      uploadId,
      id: {
        in: pageIds,
      },
    },
  });

  const existingHandles = await getExistingPageHandles(admin);

  const duplicateIds = [];
  const newIds = [];

  for (const record of records) {
    const handle = buildYMMTPageHandle(record, upload.sourceProductHandle);

    if (existingHandles.has(handle)) {
      duplicateIds.push(record.id);
    } else {
      newIds.push(record.id);
    }
  }

  const allowedSelectedIds = selectedIds.filter((id) => newIds.includes(id));

  const operations = [
    db.ymmtRecord.updateMany({
      where: {
        uploadId,
        id: {
          in: pageIds,
        },
      },
      data: {
        selected: false,
      },
    }),
  ];

  if (newIds.length > 0) {
    operations.push(
      db.ymmtRecord.updateMany({
        where: {
          uploadId,
          id: {
            in: newIds,
          },
        },
        data: {
          duplicate: false,
        },
      }),
    );
  }

  if (duplicateIds.length > 0) {
    operations.push(
      db.ymmtRecord.updateMany({
        where: {
          uploadId,
          id: {
            in: duplicateIds,
          },
        },
        data: {
          duplicate: true,
          selected: false,
        },
      }),
    );
  }

  if (allowedSelectedIds.length > 0) {
    operations.push(
      db.ymmtRecord.updateMany({
        where: {
          uploadId,
          id: {
            in: allowedSelectedIds,
          },
        },
        data: {
          selected: true,
        },
      }),
    );
  }

  await db.$transaction(operations);
}

/*
 * Select ALL matching records, not only the
 * rows currently shown on the review page.
 *
 * Records are processed in batches so we don't
 * render thousands of records in the browser.
 */
async function selectAllMatchingRecords({ uploadId, upload, filters, admin }) {
  const existingHandles = await getExistingPageHandles(admin);

  /*
   * Clear the previous selection first.
   * This makes "Select All Matching" mean exactly
   * the current filtered result set.
   */
  await db.ymmtRecord.updateMany({
    where: {
      uploadId,
    },
    data: {
      selected: false,
    },
  });

  const batchSize = 1000;

  let currentPage = 1;
  let totalPages = 1;

  do {
    const result = await getFilteredYMMTRecords({
      uploadId,
      ...filters,
      page: currentPage,
      pageSize: batchSize,
    });

    totalPages = result.totalPages;

    const duplicateIds = [];
    const selectableIds = [];

    for (const record of result.records) {
      const handle = buildYMMTPageHandle(record, upload.sourceProductHandle);

      if (existingHandles.has(handle)) {
        duplicateIds.push(record.id);
      } else {
        selectableIds.push(record.id);
      }
    }

    const operations = [];

    if (duplicateIds.length > 0) {
      operations.push(
        db.ymmtRecord.updateMany({
          where: {
            uploadId,
            id: {
              in: duplicateIds,
            },
          },
          data: {
            duplicate: true,
            selected: false,
          },
        }),
      );
    }

    if (selectableIds.length > 0) {
      operations.push(
        db.ymmtRecord.updateMany({
          where: {
            uploadId,
            id: {
              in: selectableIds,
            },
          },
          data: {
            duplicate: false,
            selected: true,
          },
        }),
      );
    }

    if (operations.length > 0) {
      await db.$transaction(operations);
    }

    currentPage += 1;
  } while (currentPage <= totalPages);
}

/* -------------------------------------------------------
   Loader
------------------------------------------------------- */

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);

  const url = new URL(request.url);

  const uploadId = url.searchParams.get("uploadId");

  if (!uploadId) {
    throw new Response("Upload ID is required.", {
      status: 400,
    });
  }

  const upload = await getYMMTUpload({
    uploadId,
    shop: session.shop,
  });

  if (!upload) {
    throw new Response("YMMT upload not found.", {
      status: 404,
    });
  }

  const filters = getFiltersFromURL(url);

  const requestedPage = Number(url.searchParams.get("page") || "1");

  const page =
    Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;

  /*
   * Review only renders 50 at a time.
   */
  const pageSize = 50;

  const result = await getFilteredYMMTRecords({
    uploadId,
    ...filters,
    page,
    pageSize,
  });

  const existingHandles = await getExistingPageHandles(admin);

  const records = result.records.map((record) => {
    const proposedHandle = buildYMMTPageHandle(
      record,
      upload.sourceProductHandle,
    );

    return {
      ...record,

      proposedTitle: buildYMMTPageTitle(record, upload.sourceProductHandle),

      proposedHandle,

      duplicate: existingHandles.has(proposedHandle),
    };
  });

  /*
   * Selected count is across ALL pages.
   */
  const selectedCount = await db.ymmtRecord.count({
    where: {
      uploadId,
      selected: true,
      duplicate: false,
    },
  });

  return {
    upload,
    filters,
    records,

    total: result.total,
    totalPages: result.totalPages,

    page,
    pageSize,

    selectedCount,
  };
};

/* -------------------------------------------------------
   Action
------------------------------------------------------- */

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);

  const formData = await request.formData();

  const intent = String(formData.get("intent") || "");

  const uploadId = String(formData.get("uploadId") || "");

  if (!uploadId) {
    throw new Response("Upload ID is required.", {
      status: 400,
    });
  }

  const upload = await getYMMTUpload({
    uploadId,
    shop: session.shop,
  });

  if (!upload) {
    throw new Response("YMMT upload not found.", {
      status: 404,
    });
  }

  const filters = getFiltersFromForm(formData);

  const currentPage = Math.max(1, Number(formData.get("currentPage") || "1"));

  /*
   * SELECT ALL MATCHING RECORDS
   */
  if (intent === "select-all-matching") {
    await selectAllMatchingRecords({
      uploadId,
      upload,
      filters,
      admin,
    });

    return redirect(
      buildReviewURL({
        uploadId,
        filters,
        page: currentPage,
      }),
    );
  }

  /*
   * CLEAR THE ENTIRE SELECTION
   */
  if (intent === "clear-selection") {
    await db.ymmtRecord.updateMany({
      where: {
        uploadId,
      },
      data: {
        selected: false,
      },
    });

    return redirect(
      buildReviewURL({
        uploadId,
        filters,
        page: currentPage,
      }),
    );
  }

  /*
   * Everything below may need to save
   * the visible page first.
   */
  const pageIds = formData.getAll("pageIds").map(String);

  const selectedIds = formData.getAll("selectedIds").map(String);

  await saveCurrentPageSelection({
    uploadId,
    pageIds,
    selectedIds,
    upload,
    admin,
  });

  /*
   * Previous / Next pagination
   */
  if (intent === "go-page") {
    const targetPage = Math.max(
      1,
      Number(formData.get("targetPage") || currentPage),
    );

    return redirect(
      buildReviewURL({
        uploadId,
        filters,
        page: targetPage,
      }),
    );
  }

  /*
   * Continue to final confirmation.
   *
   * The current page is saved above,
   * while selections from other pages
   * remain stored in Prisma.
   */
  if (intent === "continue") {
    return redirect(`/app/create?uploadId=${encodeURIComponent(uploadId)}`);
  }

  return redirect(
    buildReviewURL({
      uploadId,
      filters,
      page: currentPage,
    }),
  );
};

/* -------------------------------------------------------
   UI
------------------------------------------------------- */

import {
  UploadIcon,
  ProductIcon,
  FilterIcon,
  CheckCircleIcon,
  PageAddIcon,
} from "@shopify/polaris-icons";

const steps = [
  {
    label: "Upload Data",
    icon: UploadIcon,
  },
  {
    label: "Select Product",
    icon: ProductIcon,
  },
  {
    label: "Filter & Preview",
    icon: FilterIcon,
  },
  {
    label: "Review & Select",
    icon: CheckCircleIcon,
  },
  {
    label: "Create Pages",
    icon: PageAddIcon,
  },
];

const statCardStyle = {
  background: "#ffffff",
  border: "1px solid #e3e3e3",
  borderRadius: "12px",
  padding: "16px",
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

export default function Review() {
  const { upload, records, total, totalPages, page, filters, selectedCount } =
    useLoaderData();

  const navigation = useNavigation();

  const busy = navigation.state === "submitting";

  /*
   * Current-page selections.
   *
   * Records already saved as selected in
   * Prisma remain checked after changing
   * review pages.
   */
  const [selectedIds, setSelectedIds] = useState(
    () =>
      new Set(
        records
          .filter((record) => !record.duplicate && record.selected)
          .map((record) => record.id),
      ),
  );

  /*
   * Reset local checkboxes whenever
   * pagination loads another set of rows.
   */
  useEffect(() => {
    setSelectedIds(
      new Set(
        records
          .filter((record) => !record.duplicate && record.selected)
          .map((record) => record.id),
      ),
    );
  }, [records]);

  const selectableRecords = records.filter((record) => !record.duplicate);

  const duplicateCount = records.filter((record) => record.duplicate).length;

  const newCount = selectableRecords.length;

  const allPageSelected =
    selectableRecords.length > 0 &&
    selectableRecords.every((record) => selectedIds.has(record.id));

  const toggleRecord = (id) => {
    setSelectedIds((current) => {
      const next = new Set(current);

      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }

      return next;
    });
  };

  /*
   * This button only affects visible rows.
   */
  const toggleCurrentPage = () => {
    if (allPageSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(selectableRecords.map((record) => record.id)));
    }
  };

  /*
   * Shared hidden filter inputs.
   */
  const hiddenContext = (
    <>
      <input type="hidden" name="uploadId" value={upload.id} />

      <input type="hidden" name="currentPage" value={page} />

      <input type="hidden" name="year" value={filters.year} />

      <input type="hidden" name="make" value={filters.make} />

      <input type="hidden" name="model" value={filters.model} />

      <input type="hidden" name="trim" value={filters.trim} />

      <input type="hidden" name="manufacturer" value={filters.manufacturer} />
    </>
  );

  const filterQuery = new URLSearchParams();

  filterQuery.set("uploadId", upload.id);

  if (filters.year) {
    filterQuery.set("year", filters.year);
  }

  if (filters.make) {
    filterQuery.set("make", filters.make);
  }

  if (filters.model) {
    filterQuery.set("model", filters.model);
  }

  if (filters.trim) {
    filterQuery.set("trim", filters.trim);
  }

  if (filters.manufacturer) {
    filterQuery.set("manufacturer", filters.manufacturer);
  }

  return (
    <s-page heading="Create YMMT Pages">
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "24px",
        }}
      >
        {/* Workflow */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            flexWrap: "wrap",
          }}
        >
          {steps.map((step, index) => {
            const Icon = step.icon;

            const isActive = index === 3;
            // Upload = 0
            // Product = 1
            // Filter = 2
            // Review = 3
            // Create = 4

            return (
              <div
                key={step.label}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                }}
              >
                <div
                  style={{
                    width: "160px",
                    height: "40px",

                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "7px",

                    padding: "0 10px",
                    boxSizing: "border-box",

                    borderRadius: "9px",
                    border: isActive
                      ? "1px solid #303030"
                      : "1px solid #d8d8d8",

                    background: isActive ? "#303030" : "#ffffff",

                    color: isActive ? "#ffffff" : "#616161",

                    fontSize: "14px",
                    fontWeight: isActive ? "650" : "500",

                    whiteSpace: "nowrap",
                  }}
                >
                  <span
                    style={{
                      width: "16px",
                      height: "16px",
                      display: "inline-flex",
                      fill: isActive ? "#ffffff" : "#616161",
                      flexShrink: 0,
                    }}
                  >
                    <Icon />
                  </span>

                  <span>{step.label}</span>
                </div>

                {index < steps.length - 1 && (
                  <span
                    style={{
                      color: "#8a8a8a",
                      fontSize: "14px",
                      lineHeight: 1,
                    }}
                  >
                    →
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {/* Intro */}
        <s-section>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "7px",
            }}
          >
            <s-icon type="check-circle" />
            <strong>Review & Select</strong>
          </div>
          <s-paragraph>
            Review the proposed Shopify pages before creation. Existing page
            handles are marked as duplicates and cannot be selected.
          </s-paragraph>

          <div
            style={{
              marginTop: "16px",
              display: "flex",
              flexWrap: "wrap",
              gap: "10px",
            }}
          >
            <div
              style={{
                padding: "9px 12px",
                background: "#f6f6f7",
                borderRadius: "8px",
                fontSize: "13px",
              }}
            >
              File: <strong>{upload.fileName}</strong>
            </div>

            <div
              style={{
                padding: "9px 12px",
                background: "#f6f6f7",
                borderRadius: "8px",
                fontSize: "13px",
              }}
            >
              Product:{" "}
              <strong>
                {upload.sourceProductHandle || "No product suffix"}
              </strong>
            </div>
          </div>
        </s-section>

        {/* Stats */}
        <div
          style={{
            display: "grid",

            gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",

            gap: "12px",
          }}
        >
          <div style={statCardStyle}>
            <div
              style={{
                color: "#616161",
                fontSize: "13px",
              }}
            >
              Matching Records
            </div>

            <div
              style={{
                fontSize: "25px",
                fontWeight: "700",
                marginTop: "4px",
              }}
            >
              {total}
            </div>
          </div>

          <div style={statCardStyle}>
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
                fontSize: "25px",
                fontWeight: "700",
                marginTop: "4px",
              }}
            >
              {selectedCount}
            </div>
          </div>

          <div style={statCardStyle}>
            <div
              style={{
                color: "#616161",
                fontSize: "13px",
              }}
            >
              New on This Page
            </div>

            <div
              style={{
                fontSize: "25px",
                fontWeight: "700",
                marginTop: "4px",
              }}
            >
              {newCount}
            </div>
          </div>

          <div style={statCardStyle}>
            <div
              style={{
                color: "#616161",
                fontSize: "13px",
              }}
            >
              Duplicates on This Page
            </div>

            <div
              style={{
                fontSize: "25px",
                fontWeight: "700",
                marginTop: "4px",
              }}
            >
              {duplicateCount}
            </div>
          </div>
        </div>

        {/* Selection */}
        <s-section>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "7px",
            }}
          >
            <s-icon type="check-circle" />
            <strong>Selection</strong>
          </span>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "10px",
            }}
          >
            <button
              type="button"
              onClick={toggleCurrentPage}
              style={{
                padding: "9px 14px",
                borderRadius: "8px",
                border: "1px solid #c9c9c9",
                background: "#ffffff",
                fontWeight: "600",
                cursor: "pointer",
              }}
            >
              {allPageSelected
                ? "Deselect Current Page"
                : "Select Current Page"}
            </button>

            {/* Select all matching */}
            <Form method="post">
              {hiddenContext}

              <button
                type="submit"
                name="intent"
                value="select-all-matching"
                disabled={busy || total === 0}
                style={{
                  padding: "9px 14px",
                  borderRadius: "8px",
                  border: "none",
                  background: "#303030",
                  color: "#ffffff",
                  fontWeight: "650",
                  cursor: "pointer",
                }}
              >
                Select All Matching New Pages ({total})
              </button>
            </Form>

            {/* Clear all */}
            <Form method="post">
              {hiddenContext}

              <button
                type="submit"
                name="intent"
                value="clear-selection"
                disabled={busy || selectedCount === 0}
                style={{
                  padding: "9px 14px",
                  borderRadius: "8px",
                  border: "1px solid #c9c9c9",
                  background: "#ffffff",
                  fontWeight: "600",
                }}
              >
                Clear All Selection
              </button>
            </Form>
          </div>
        </s-section>

        {/* Main form */}
        <Form method="post">
          {hiddenContext}

          {/* Current page IDs */}
          {records.map((record) => (
            <input
              key={`page-${record.id}`}
              type="hidden"
              name="pageIds"
              value={record.id}
            />
          ))}

          {/* Selected current-page IDs */}
          {[...selectedIds].map((id) => (
            <input
              key={`selected-${id}`}
              type="hidden"
              name="selectedIds"
              value={id}
            />
          ))}

          <s-section>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "7px",
              }}
            >
              <s-icon type="page" />
              <strong>Pages</strong>
            </span>
            {records.length > 0 ? (
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
                      background: "#ffffff",
                    }}
                  >
                    <thead>
                      <tr>
                        <th style={tableHeaderStyle}>Select</th>

                        <th align="left" style={tableHeaderStyle}>
                          Vehicle
                        </th>

                        <th align="left" style={tableHeaderStyle}>
                          Manufacturer
                        </th>

                        <th align="left" style={tableHeaderStyle}>
                          Compatibility
                        </th>

                        <th align="left" style={tableHeaderStyle}>
                          Status
                        </th>

                        <th align="left" style={tableHeaderStyle}>
                          Page Title
                        </th>

                        <th align="left" style={tableHeaderStyle}>
                          Page Handle
                        </th>
                      </tr>
                    </thead>

                    <tbody>
                      {records.map((record) => (
                        <tr
                          key={record.id}
                          style={{
                            background: record.duplicate
                              ? "#fafafa"
                              : "#ffffff",

                            opacity: record.duplicate ? 0.7 : 1,
                          }}
                        >
                          <td style={tableCellStyle}>
                            <input
                              type="checkbox"

                              checked={selectedIds.has(record.id)}

                              disabled={record.duplicate}

                              onChange={() => toggleRecord(record.id)}
                            />
                          </td>

                          <td style={tableCellStyle}>
                            <strong>
                              {record.year} {record.make} {record.model}
                            </strong>

                            {record.trim && (
                              <div
                                style={{
                                  marginTop: "3px",

                                  color: "#616161",
                                }}
                              >
                                {record.trim}
                              </div>
                            )}
                          </td>

                          <td style={tableCellStyle}>
                            {record.manufacturer || "—"}
                          </td>

                          <td style={tableCellStyle}>
                            {record.compatible || "—"}
                          </td>

                          <td style={tableCellStyle}>
                            <span
                              style={{
                                display: "inline-block",

                                padding: "4px 8px",

                                borderRadius: "999px",

                                fontSize: "12px",

                                fontWeight: "650",

                                background: record.duplicate
                                  ? "#fbeae5"
                                  : "#eaf7ee",

                                color: record.duplicate ? "#8a2e1b" : "#176b35",
                              }}
                            >
                              {record.duplicate ? "Duplicate" : "New"}
                            </span>
                          </td>

                          <td style={tableCellStyle}>{record.proposedTitle}</td>

                          <td style={tableCellStyle}>
                            <code
                              style={{
                                fontSize: "12px",

                                wordBreak: "break-word",
                              }}
                            >
                              {record.proposedHandle}
                            </code>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Pagination */}
                {totalPages > 1 && (
                  <div
                    style={{
                      marginTop: "18px",

                      display: "flex",

                      justifyContent: "space-between",

                      alignItems: "center",

                      gap: "12px",

                      flexWrap: "wrap",
                    }}
                  >
                    <div>
                      {page > 1 && (
                        <button
                          type="submit"

                          name="intent"

                          value="go-page"

                          onClick={(event) => {
                            const form = event.currentTarget.form;

                            const target = document.createElement("input");

                            target.type = "hidden";

                            target.name = "targetPage";

                            target.value = String(page - 1);

                            form.appendChild(target);
                          }}

                          style={{
                            padding: "9px 14px",

                            borderRadius: "8px",

                            border: "1px solid #c9c9c9",

                            background: "#ffffff",

                            fontWeight: "600",
                          }}
                        >
                          ← Previous
                        </button>
                      )}
                    </div>

                    <div
                      style={{
                        color: "#616161",

                        fontSize: "13px",
                      }}
                    >
                      Page <strong>{page}</strong> of{" "}
                      <strong>{totalPages}</strong>
                      {" · "}
                      {records.length} rows shown
                    </div>

                    <div>
                      {page < totalPages && (
                        <button
                          type="submit"

                          name="intent"

                          value="go-page"

                          onClick={(event) => {
                            const form = event.currentTarget.form;

                            const target = document.createElement("input");

                            target.type = "hidden";

                            target.name = "targetPage";

                            target.value = String(page + 1);

                            form.appendChild(target);
                          }}

                          style={{
                            padding: "9px 14px",

                            borderRadius: "8px",

                            border: "1px solid #c9c9c9",

                            background: "#ffffff",

                            fontWeight: "600",
                          }}
                        >
                          Next →
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div
                style={{
                  padding: "30px",

                  textAlign: "center",

                  color: "#616161",

                  background: "#fafafa",

                  borderRadius: "10px",

                  border: "1px dashed #c9c9c9",
                }}
              >
                No records available for review.
              </div>
            )}
          </s-section>

          {/* Bottom controls */}
          <div
            style={{
              marginTop: "24px",

              display: "flex",

              justifyContent: "space-between",

              alignItems: "center",

              gap: "12px",

              flexWrap: "wrap",
            }}
          >
            <Link
              to={`/app/filter?${filterQuery.toString()}`}
              style={{
                color: "#616161",

                textDecoration: "none",

                fontWeight: "600",
              }}
            >
              ← Back to Filter & Preview
            </Link>

            <button
              type="submit"
              name="intent"
              value="continue"
              disabled={busy || (selectedCount === 0 && selectedIds.size === 0)}
              style={{
                padding: "11px 18px",

                borderRadius: "8px",

                border: "none",

                background:
                  selectedCount === 0 && selectedIds.size === 0
                    ? "#b5b5b5"
                    : "#303030",

                color: "#ffffff",

                fontWeight: "650",

                cursor:
                  selectedCount === 0 && selectedIds.size === 0
                    ? "not-allowed"
                    : "pointer",
              }}
            >
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                }}
              >
                Continue to Create
                {selectedCount > 0 && ` (${selectedCount})`} →
                <s-icon type="arrow-right" />
              </span>
            </button>
          </div>
        </Form>
      </div>
    </s-page>
  );
}
