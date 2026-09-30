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

  if (filters.year) params.set("year", filters.year);
  if (filters.make) params.set("make", filters.make);
  if (filters.model) params.set("model", filters.model);
  if (filters.trim) params.set("trim", filters.trim);
  if (filters.manufacturer) {
    params.set("manufacturer", filters.manufacturer);
  }

  params.set("page", String(page));

  return `/app/review?${params.toString()}`;
}

function buildRecordProposals(record, upload, existingHandles) {
  const sourceProducts =
    upload.sourceProducts?.length > 0 ? upload.sourceProducts : [null];

  return sourceProducts.map((product) => {
    const sourceProductHandle = product?.handle || null;

    const proposedHandle = buildYMMTPageHandle(record, sourceProductHandle);

    return {
      productId: product?.productId || null,
      productTitle: product?.title || null,
      sourceProductHandle,
      proposedTitle: buildYMMTPageTitle(record, sourceProductHandle),
      proposedHandle,
      duplicate: existingHandles.has(proposedHandle),
    };
  });
}

async function saveCurrentPageSelection({
  uploadId,
  pageIds,
  selectedIds,
  upload,
  admin,
}) {
  if (!pageIds.length) return;

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
  const selectableIds = [];

  for (const record of records) {
    const proposals = buildRecordProposals(record, upload, existingHandles);

    const allDuplicate =
      proposals.length > 0 && proposals.every((proposal) => proposal.duplicate);

    if (allDuplicate) {
      duplicateIds.push(record.id);
    } else {
      selectableIds.push(record.id);
    }
  }

  const allowedSelectedIds = selectedIds.filter((id) =>
    selectableIds.includes(id),
  );

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

async function selectAllMatchingRecords({ uploadId, upload, filters, admin }) {
  const existingHandles = await getExistingPageHandles(admin);

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
      const proposals = buildRecordProposals(record, upload, existingHandles);

      const allDuplicate =
        proposals.length > 0 &&
        proposals.every((proposal) => proposal.duplicate);

      if (allDuplicate) {
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

  const pageSize = 50;

  const result = await getFilteredYMMTRecords({
    uploadId,
    ...filters,
    page,
    pageSize,
  });

  const existingHandles = await getExistingPageHandles(admin);

  const records = result.records.map((record) => {
    const proposals = buildRecordProposals(record, upload, existingHandles);

    return {
      ...record,
      proposals,
      duplicate:
        proposals.length > 0 &&
        proposals.every((proposal) => proposal.duplicate),
      newPageCount: proposals.filter((proposal) => !proposal.duplicate).length,
    };
  });

  const selectedCount = await db.ymmtRecord.count({
    where: {
      uploadId,
      selected: true,
      duplicate: false,
    },
  });

  const selectedRecords = await db.ymmtRecord.findMany({
    where: {
      uploadId,
      selected: true,
      duplicate: false,
    },
  });

  let selectedPageCount = 0;

  for (const record of selectedRecords) {
    selectedPageCount += buildRecordProposals(
      record,
      upload,
      existingHandles,
    ).filter((proposal) => !proposal.duplicate).length;
  }

  return {
    upload,
    filters,
    records,
    total: result.total,
    totalPages: result.totalPages,
    page,
    pageSize,
    selectedCount,
    selectedPageCount,
  };
};

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

  const pageIds = formData.getAll("pageIds").map(String);
  const selectedIds = formData.getAll("selectedIds").map(String);

  await saveCurrentPageSelection({
    uploadId,
    pageIds,
    selectedIds,
    upload,
    admin,
  });

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

import {
  UploadIcon,
  ProductIcon,
  FilterIcon,
  CheckCircleIcon,
  PageAddIcon,
} from "@shopify/polaris-icons";

const steps = [
  { label: "Upload Data", icon: UploadIcon },
  { label: "Select Products", icon: ProductIcon },
  { label: "Filter & Preview", icon: FilterIcon },
  { label: "Review & Select", icon: CheckCircleIcon },
  { label: "Create Pages", icon: PageAddIcon },
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
  const {
    upload,
    records,
    total,
    totalPages,
    page,
    filters,
    selectedCount,
    selectedPageCount,
  } = useLoaderData();

  const navigation = useNavigation();
  const busy = navigation.state === "submitting";

  const [selectedIds, setSelectedIds] = useState(
    () =>
      new Set(
        records
          .filter((record) => !record.duplicate && record.selected)
          .map((record) => record.id),
      ),
  );

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

  const toggleCurrentPage = () => {
    if (allPageSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(selectableRecords.map((record) => record.id)));
    }
  };

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

  if (filters.year) filterQuery.set("year", filters.year);
  if (filters.make) filterQuery.set("make", filters.make);
  if (filters.model) filterQuery.set("model", filters.model);
  if (filters.trim) filterQuery.set("trim", filters.trim);

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

                {index < steps.length - 1 && <span>→</span>}
              </div>
            );
          })}
        </div>

        <s-section>
          <strong>Review & Select</strong>

          <s-paragraph>
            Review vehicle records before creation. Each selected vehicle will
            create one page for every selected product whose handle does not
            already exist.
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
              Products:{" "}
              <strong>
                {upload.sourceProducts?.length > 0
                  ? upload.sourceProducts
                      .map((product) => product.handle)
                      .join(", ")
                  : "No product suffix"}
              </strong>
            </div>
          </div>
        </s-section>

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
                marginBottom: "5px",
              }}
            >
              Matching Vehicles
            </div>
            <div style={{ fontSize: "25px", fontWeight: "700" }}>{total}</div>
          </div>

          <div style={statCardStyle}>
            <div
              style={{
                color: "#616161",
                fontSize: "13px",
                marginBottom: "5px",
              }}
            >
              Selected Vehicles
            </div>
            <div style={{ fontSize: "25px", fontWeight: "700" }}>
              {selectedCount}
            </div>
          </div>

          <div style={statCardStyle}>
            <div
              style={{
                color: "#616161",
                fontSize: "13px",
                marginBottom: "5px",
              }}
            >
              Selected New Pages
            </div>
            <div style={{ fontSize: "25px", fontWeight: "700" }}>
              {selectedPageCount}
            </div>
          </div>

          <div style={statCardStyle}>
            <div
              style={{
                color: "#616161",
                fontSize: "13px",
                marginBottom: "5px",
              }}
            >
              Fully Duplicate Vehicles
            </div>
            <div style={{ fontSize: "25px", fontWeight: "700" }}>
              {duplicateCount}
            </div>
          </div>
        </div>

        <s-section>
          <strong>Selection</strong>

          <div
            style={{
              marginTop: "12px",
              display: "flex",
              flexWrap: "wrap",
              gap: "10px",
            }}
          >
            <button
              type="button"
              onClick={toggleCurrentPage}
              style={{
                display: "inline-block",
                background: "#303030",
                color: "#ffffff",
                textDecoration: "none",
                padding: "11px 18px",
                borderRadius: "8px",
                fontWeight: "650",
              }}
            >
              {allPageSelected
                ? "Deselect Current Page"
                : "Select Current Page"}
            </button>

            <Form method="post">
              {hiddenContext}

              <button
                type="submit"
                name="intent"
                value="select-all-matching"
                style={{
                  display: "inline-block",
                  background: "#303030",
                  color: "#ffffff",
                  textDecoration: "none",
                  padding: "11px 18px",
                  borderRadius: "8px",
                  fontWeight: "650",
                }}
                disabled={busy || total === 0}
              >
                Select All Matching Vehicles ({total})
              </button>
            </Form>

            <Form method="post">
              {hiddenContext}

              <button
                type="submit"
                name="intent"
                value="clear-selection"
                disabled={busy || selectedCount === 0}
                style={{
                  display: "inline-block",
                  background: "#303030",
                  color: "#ffffff",
                  textDecoration: "none",
                  padding: "11px 18px",
                  borderRadius: "8px",
                  fontWeight: "650",
                }}
              >
                Clear All Selection
              </button>
            </Form>
          </div>
        </s-section>

        <Form method="post">
          {hiddenContext}

          {records.map((record) => (
            <input
              key={`page-${record.id}`}
              type="hidden"
              name="pageIds"
              value={record.id}
            />
          ))}

          {[...selectedIds].map((id) => (
            <input
              key={`selected-${id}`}
              type="hidden"
              name="selectedIds"
              value={id}
            />
          ))}

          <s-section>
            <strong>Pages</strong>

            {records.length > 0 ? (
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
                        Product Pages
                      </th>
                    </tr>
                  </thead>

                  <tbody>
                    {records.map((record) => (
                      <tr key={record.id}>
                        <td style={tableCellStyle}>
                          <input
                            type="checkbox"
                            aria-label={`Select ${record.year} ${record.make} ${record.model} ${record.trim || ""}`}
                            checked={selectedIds.has(record.id)}
                            disabled={record.duplicate}
                            onChange={() => toggleRecord(record.id)}
                          />
                        </td>

                        <td style={tableCellStyle}>
                          <strong>
                            {record.year} {record.make} {record.model}
                          </strong>
                          {record.trim && <div>{record.trim}</div>}
                        </td>

                        <td style={tableCellStyle}>
                          {record.manufacturer || "—"}
                        </td>

                        <td style={tableCellStyle}>
                          {record.compatible || "—"}
                        </td>

                        <td style={tableCellStyle}>
                          <div
                            style={{
                              display: "flex",
                              flexDirection: "column",
                              gap: "7px",
                            }}
                          >
                            {record.proposals.map((proposal) => (
                              <div
                                key={proposal.proposedHandle}
                                style={{
                                  padding: "8px 10px",
                                  border: "1px solid #e3e3e3",
                                  borderRadius: "8px",
                                  background: proposal.duplicate
                                    ? "#fff8f7"
                                    : "#f5fbf6",
                                }}
                              >
                                <div
                                  style={{
                                    fontSize: "11px",
                                    fontWeight: "650",
                                  }}
                                >
                                  {proposal.duplicate ? "EXISTS" : "NEW"}
                                  {proposal.sourceProductHandle
                                    ? ` · ${proposal.sourceProductHandle}`
                                    : ""}
                                </div>

                                <code
                                  style={{
                                    display: "block",
                                    marginTop: "3px",
                                    fontSize: "12px",
                                    wordBreak: "break-word",
                                  }}
                                >
                                  {proposal.proposedHandle}
                                </code>
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div>No records available for review.</div>
            )}

            {totalPages > 1 && (
              <div
                style={{
                  marginTop: "18px",
                  display: "flex",
                  justifyContent: "space-between",
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
                    >
                      ← Previous
                    </button>
                  )}
                </div>

                <div>
                  Page <strong>{page}</strong> of <strong>{totalPages}</strong>
                </div>

                <div>
                  {page < totalPages && (
                    <button
                      type="submit"
                      name="intent"
                      value="go-page"
                      style={{
                        padding: "9px 14px",
                        borderRadius: "8px",
                        border: "1px solid #c9c9c9",
                        background: "#ffffff",
                        fontWeight: "650",
                        cursor: "pointer",
                      }}
                      onClick={(event) => {
                        const form = event.currentTarget.form;
                        const target = document.createElement("input");

                        target.type = "hidden";
                        target.name = "targetPage";
                        target.value = String(page + 1);

                        form.appendChild(target);
                      }}
                    >
                      Next →
                    </button>
                  )}
                </div>
              </div>
            )}
          </s-section>

          <div
            style={{
              marginTop: "24px",
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            <Link to={`/app/filter?${filterQuery.toString()}`}>
              ← Back to Filter & Preview
            </Link>

            <button
              type="submit"
              name="intent"
              value="continue"
              disabled={busy || (selectedCount === 0 && selectedIds.size === 0)}
              style={{
                display: "inline-block",
                background: "#303030",
                color: "#ffffff",
                textDecoration: "none",
                padding: "11px 18px",
                borderRadius: "8px",
                fontWeight: "650",
              }}
            >
              Continue to Create →
            </button>
          </div>
        </Form>
      </div>
    </s-page>
  );
}
