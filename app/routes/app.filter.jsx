import { Form, Link, useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";
import {
  getYMMTFilterOptions,
  getFilteredYMMTRecords,
} from "../lib/ymmt-uploads.server";

import { buildYMMTPageHandle } from "../lib/ymmt-pages";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  const url = new URL(request.url);

  const uploadId = url.searchParams.get("uploadId");

  if (!uploadId) {
    throw new Response("Upload ID is required.", {
      status: 400,
    });
  }

  const year = url.searchParams.get("year") || "";
  const make = url.searchParams.get("make") || "";
  const model = url.searchParams.get("model") || "";
  const trim = url.searchParams.get("trim") || "";
  const manufacturer = url.searchParams.get("manufacturer") || "";

  const requestedPage = Number(url.searchParams.get("page") || "1");

  const page =
    Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;

  const options = await getYMMTFilterOptions({
    uploadId,
    shop: session.shop,
    year,
    make,
  });

  if (!options?.upload) {
    throw new Response("YMMT upload not found.", {
      status: 404,
    });
  }

  /*
   * Keep models dependent on the selected make when possible.
   * This preserves the behavior of the existing filter route.
   */
  let models = options.models;

  if (make) {
    const makeRecords = await getFilteredYMMTRecords({
      uploadId,
      make,
      page: 1,
      pageSize: 10000,
    });

    models = [
      ...new Set(makeRecords.records.map((record) => record.model)),
    ].sort();
  }

  const result = await getFilteredYMMTRecords({
    uploadId,
    year,
    make,
    model,
    trim,
    manufacturer,
    page,
    pageSize: 25,
  });

  return {
    upload: options.upload,

    filters: {
      year,
      make,
      model,
      trim,
      manufacturer,
    },

    options: {
      years: options.years,
      makes: options.makes,
      models,
      trims: options.trims,
      manufacturers: options.manufacturers,
    },

    records: result.records,
    total: result.total,
    totalPages: result.totalPages,
    page,
  };
};
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

const selectStyle = {
  width: "100%",
  padding: "10px 12px",
  border: "1px solid #c9c9c9",
  borderRadius: "8px",
  background: "#ffffff",
  fontSize: "14px",
};

const labelStyle = {
  display: "block",
  fontSize: "13px",
  fontWeight: "650",
  marginBottom: "6px",
  color: "#303030",
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

export default function FilterPreview() {
  const { upload, filters, options, records, total, totalPages, page } =
    useLoaderData();

  const hasFilters =
    filters.year ||
    filters.make ||
    filters.model ||
    filters.trim ||
    filters.manufacturer;

  const buildPageUrl = (targetPage) => {
    const params = new URLSearchParams();

    params.set("uploadId", upload.id);

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

    params.set("page", String(targetPage));

    return `?${params.toString()}`;
  };

  const reviewParams = new URLSearchParams();

  reviewParams.set("uploadId", upload.id);

  if (filters.year) {
    reviewParams.set("year", filters.year);
  }

  if (filters.make) {
    reviewParams.set("make", filters.make);
  }

  if (filters.model) {
    reviewParams.set("model", filters.model);
  }

  if (filters.trim) {
    reviewParams.set("trim", filters.trim);
  }

  if (filters.manufacturer) {
    reviewParams.set("manufacturer", filters.manufacturer);
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

            const isActive = index === 2;
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

        {/* Current upload */}
        <s-section>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "7px",
            }}
          >
            <s-icon type="view" />
            <strong>Filter & Preview</strong>
          </div>
          <s-paragraph>
            Narrow the uploaded YMMT data before selecting which Shopify pages
            should be created.
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
              Records: <strong>{upload.totalRecords}</strong>
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

        {/* Filters */}
        <s-section>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "7px",
            }}
          >
            <s-icon type="filter" />
            <strong>Filters</strong>
          </span>
          <Form method="get">
            <input type="hidden" name="uploadId" value={upload.id} />

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                gap: "16px",
              }}
            >
              <div>
                <label htmlFor="year" style={labelStyle}>
                  Year
                </label>

                <select
                  id="year"
                  name="year"
                  defaultValue={filters.year}
                  style={selectStyle}
                >
                  <option value="">All Years</option>

                  {options.years.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="make" style={labelStyle}>
                  Make
                </label>

                <select
                  id="make"
                  name="make"
                  defaultValue={filters.make}
                  style={selectStyle}
                >
                  <option value="">All Makes</option>

                  {options.makes.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="model" style={labelStyle}>
                  Model
                </label>

                <select
                  id="model"
                  name="model"
                  defaultValue={filters.model}
                  style={selectStyle}
                >
                  <option value="">All Models</option>

                  {options.models.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="trim" style={labelStyle}>
                  Trim
                </label>

                <select
                  id="trim"
                  name="trim"
                  defaultValue={filters.trim}
                  style={selectStyle}
                >
                  <option value="">All Trims</option>

                  <option value="__NO_TRIM__">No Trim</option>

                  {options.trims.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="manufacturer" style={labelStyle}>
                  Manufacturer
                </label>

                <select
                  id="manufacturer"
                  name="manufacturer"
                  defaultValue={filters.manufacturer}
                  style={selectStyle}
                >
                  <option value="">All Manufacturers</option>

                  {options.manufacturers.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div
              style={{
                marginTop: "18px",
                display: "flex",
                flexWrap: "wrap",
                gap: "10px",
              }}
            >
              <s-button
                icon="filter"
                type="submit"
                style={{
                  padding: "10px 16px",
                  borderRadius: "8px",
                  border: "none",
                  background: "#303030",
                  color: "#ffffff",
                  fontWeight: "650",
                  cursor: "pointer",
                }}
              >
                Apply Filters
              </s-button>

              {hasFilters && (
                <Link
                  to={`/app/filter?uploadId=${encodeURIComponent(upload.id)}`}
                  style={{
                    padding: "9px 15px",
                    borderRadius: "8px",
                    border: "1px solid #c9c9c9",
                    color: "#303030",
                    background: "#ffffff",
                    textDecoration: "none",
                    fontWeight: "600",
                  }}
                >
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                    }}
                  >
                    <s-icon type="reset" />
                    Clear Filters
                  </span>
                </Link>
              )}
            </div>
          </Form>
        </s-section>

        {/* Results summary */}
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
              Current Page
            </div>

            <div
              style={{
                fontSize: "25px",
                fontWeight: "700",
                marginTop: "4px",
              }}
            >
              {page}
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
              Total Pages
            </div>

            <div
              style={{
                fontSize: "25px",
                fontWeight: "700",
                marginTop: "4px",
              }}
            >
              {totalPages}
            </div>
          </div>
        </div>

        {/* Preview */}
        <s-section>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "7px",
            }}
          >
            <s-icon type="view" />
            <strong>{`Preview (${total} records)`}</strong>
          </div>
          {records.length > 0 ? (
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
                      Manufacturer
                    </th>

                    <th align="left" style={tableHeaderStyle}>
                      Compatibility
                    </th>

                    <th align="left" style={tableHeaderStyle}>
                      Proposed Handle
                    </th>
                  </tr>
                </thead>

                <tbody>
                  {records.map((record) => {
                    const handle = buildYMMTPageHandle(
                      record,
                      upload.sourceProductHandle,
                    );

                    return (
                      <tr key={record.id}>
                        <td style={tableCellStyle}>{record.year}</td>

                        <td style={tableCellStyle}>{record.make}</td>

                        <td style={tableCellStyle}>{record.model}</td>

                        <td style={tableCellStyle}>{record.trim || "—"}</td>

                        <td style={tableCellStyle}>
                          {record.manufacturer || "—"}
                        </td>

                        <td style={tableCellStyle}>
                          {record.compatible || "—"}
                        </td>

                        <td style={tableCellStyle}>
                          <code
                            style={{
                              fontSize: "12px",
                              wordBreak: "break-word",
                            }}
                          >
                            {handle}
                          </code>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
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
              No records match the selected filters.
            </div>
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <div
              style={{
                marginTop: "18px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "12px",
                flexWrap: "wrap",
              }}
            >
              <div>
                {page > 1 ? (
                  <Link
                    to={buildPageUrl(page - 1)}
                    style={{
                      display: "inline-block",
                      padding: "9px 14px",
                      borderRadius: "8px",
                      border: "1px solid #c9c9c9",
                      textDecoration: "none",
                      color: "#303030",
                      fontWeight: "600",
                    }}
                  >
                    ← Previous
                  </Link>
                ) : (
                  <span />
                )}
              </div>

              <div
                style={{
                  color: "#616161",
                  fontSize: "13px",
                }}
              >
                Page <strong>{page}</strong> of <strong>{totalPages}</strong>
              </div>

              <div>
                {page < totalPages ? (
                  <Link
                    to={buildPageUrl(page + 1)}
                    style={{
                      display: "inline-block",
                      padding: "9px 14px",
                      borderRadius: "8px",
                      border: "1px solid #c9c9c9",
                      textDecoration: "none",
                      color: "#303030",
                      fontWeight: "600",
                    }}
                  >
                    Next →
                  </Link>
                ) : (
                  <span />
                )}
              </div>
            </div>
          )}
        </s-section>

        {/* Bottom actions */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "12px",
          }}
        >
          <Link
            to={`/app/product?uploadId=${encodeURIComponent(upload.id)}`}
            style={{
              color: "#616161",
              textDecoration: "none",
              fontWeight: "600",
            }}
          >
            ← Back to Product
          </Link>

          {total > 0 && (
            <Link
              to={`/app/review?${reviewParams.toString()}`}
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
              Continue to Review ({total}) →
            </Link>
          )}
        </div>
      </div>
    </s-page>
  );
}
