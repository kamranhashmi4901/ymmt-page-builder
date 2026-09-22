import { useState } from "react";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";

import { authenticate } from "../shopify.server";

function cleanTrim(value) {
  const trim = String(value || "").trim();

  if (!trim || trim.toLowerCase() === "base" || trim.toLowerCase() === "all") {
    return "";
  }

  return trim;
}

function parseVehicle(value) {
  if (!value) {
    return {};
  }

  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function applyTemplate(template, page) {
  const vehicle = page.vehicle || {};

  const replacements = {
    year: vehicle.year || "",
    make: vehicle.make || "",
    model: vehicle.model || "",
    trim: cleanTrim(vehicle.trim),
    product: String(page.productHandle || "")
      .replace(/-/g, " ")
      .trim(),
    title: page.title || "",
    handle: page.handle || "",
  };

  let result = String(template || "");

  Object.entries(replacements).forEach(([key, value]) => {
    result = result.replace(new RegExp(`\\{${key}\\}`, "gi"), value);
  });

  return result
    .replace(/\s+/g, " ")
    .replace(/\s+([,|])/g, "$1")
    .trim();
}

async function getYMMTPages(admin, search = "") {
  const pages = [];

  let cursor = null;
  let hasNextPage = true;

  const normalizedSearch = String(search || "")
    .trim()
    .toLowerCase();

  while (hasNextPage) {
    const response = await admin.graphql(
      `#graphql
        query SeoPages($after: String) {
          pages(first: 100, after: $after) {
            nodes {
              id
              title
              handle
              templateSuffix

              seoTitle: metafield(
                namespace: "global"
                key: "title_tag"
              ) {
                value
              }

              seoDescription: metafield(
                namespace: "global"
                key: "description_tag"
              ) {
                value
              }

              vehicle: metafield(
                namespace: "ymmt"
                key: "vehicle"
              ) {
                value
              }

              productHandle: metafield(
                namespace: "ymmt"
                key: "product_handle"
              ) {
                value
              }
            }

            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `,
      {
        variables: {
          after: cursor,
        },
      },
    );

    const json = await response.json();

    if (json.errors?.length) {
      throw new Error(json.errors.map((error) => error.message).join(", "));
    }

    const connection = json.data?.pages;

    if (!connection) {
      break;
    }

    connection.nodes.forEach((page) => {
      if (page.templateSuffix !== "product-ymmt") {
        return;
      }

      const matches =
        !normalizedSearch ||
        page.handle?.toLowerCase().includes(normalizedSearch) ||
        page.title?.toLowerCase().includes(normalizedSearch);

      if (!matches) {
        return;
      }

      pages.push({
        id: page.id,
        title: page.title,
        handle: page.handle,

        currentSeoTitle: page.seoTitle?.value || "",

        currentSeoDescription: page.seoDescription?.value || "",

        vehicle: parseVehicle(page.vehicle?.value),

        productHandle: page.productHandle?.value || "",
      });
    });

    hasNextPage = connection.pageInfo.hasNextPage;

    cursor = connection.pageInfo.endCursor;
  }

  return pages;
}

async function setPageSeo(admin, { pageId, seoTitle, seoDescription }) {
  const response = await admin.graphql(
    `#graphql
      mutation SetPageSEO(
        $metafields: [MetafieldsSetInput!]!
      ) {
        metafieldsSet(
          metafields: $metafields
        ) {
          metafields {
            id
            key
            value
          }

          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      variables: {
        metafields: [
          {
            ownerId: pageId,
            namespace: "global",
            key: "title_tag",
            type: "single_line_text_field",
            value: seoTitle,
          },
          {
            ownerId: pageId,
            namespace: "global",
            key: "description_tag",
            type: "single_line_text_field",
            value: seoDescription,
          },
        ],
      },
    },
  );

  const json = await response.json();

  if (json.errors?.length) {
    throw new Error(json.errors.map((error) => error.message).join(", "));
  }

  const errors = json.data?.metafieldsSet?.userErrors || [];

  if (errors.length) {
    throw new Error(errors.map((error) => error.message).join(", "));
  }
}

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const url = new URL(request.url);

  const search = url.searchParams.get("search") || "";

  const pages = await getYMMTPages(admin, search);

  return {
    pages,
    search,
  };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const formData = await request.formData();

  const intent = String(formData.get("intent") || "");

  const search = String(formData.get("search") || "");

  const titleTemplate = String(formData.get("titleTemplate") || "");

  const descriptionTemplate = String(formData.get("descriptionTemplate") || "");

  const selectedIds = formData.getAll("pageIds").map(String);

  const pages = await getYMMTPages(admin, search);

  const selectedPages =
    selectedIds.length > 0
      ? pages.filter((page) => selectedIds.includes(page.id))
      : pages;

  const preview = selectedPages.map((page) => ({
    ...page,

    proposedSeoTitle: applyTemplate(titleTemplate, page),

    proposedSeoDescription: applyTemplate(descriptionTemplate, page),
  }));

  if (intent === "preflight") {
    return {
      success: true,
      intent,
      preview,
      count: preview.length,
      titleTemplate,
      descriptionTemplate,
    };
  }

  if (intent === "update") {
    const results = [];

    for (const page of preview) {
      try {
        await setPageSeo(admin, {
          pageId: page.id,

          seoTitle: page.proposedSeoTitle,

          seoDescription: page.proposedSeoDescription,
        });

        results.push({
          handle: page.handle,
          status: "updated",
        });
      } catch (error) {
        results.push({
          handle: page.handle,
          status: "failed",
          message: error.message || "Unable to update SEO.",
        });
      }
    }

    return {
      success: true,
      intent,
      results,

      updated: results.filter((result) => result.status === "updated").length,

      failed: results.filter((result) => result.status === "failed").length,
    };
  }

  return {
    success: false,
    error: "Unknown SEO action.",
  };
};

const tableHeaderStyle = {
  padding: "12px",
  borderBottom: "1px solid #dedede",
  background: "#f7f7f7",
  fontSize: "12px",
  fontWeight: "650",
};

const tableCellStyle = {
  padding: "12px",
  borderBottom: "1px solid #eeeeee",
  verticalAlign: "top",
  fontSize: "13px",
};

export default function SeoMeta() {
  const { pages, search } = useLoaderData();

  const actionData = useActionData();

  const navigation = useNavigation();

  const busy = navigation.state === "submitting";

  const [selectedIds, setSelectedIds] = useState(new Set());

  const [titleTemplate, setTitleTemplate] = useState(
    "{year} {make} {model} {trim} Seat Covers",
  );

  const [descriptionTemplate, setDescriptionTemplate] = useState(
    "Shop seat covers for the {year} {make} {model} {trim}. Premium fit, protection and comfort.",
  );

  const togglePage = (id) => {
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

  const allSelected =
    pages.length > 0 && pages.every((page) => selectedIds.has(page.id));

  return (
    <s-page heading="SEO Meta">
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "20px",
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
            <strong>Search YMMT Pages</strong>
          </span>

          <Form method="get">
            <div
              style={{
                marginTop: "14px",
                display: "flex",
                gap: "10px",
              }}
            >
              <input
                type="text"
                name="search"
                defaultValue={search}
                placeholder="Search by title or handle..."
                style={{
                  flex: 1,
                  padding: "10px 12px",
                  border: "1px solid #c9c9c9",
                  borderRadius: "8px",
                }}
              />

              <button type="submit">Search</button>
            </div>
          </Form>
        </s-section>

        <Form method="post">
          <input type="hidden" name="search" value={search} />

          {[...selectedIds].map((id) => (
            <input key={id} type="hidden" name="pageIds" value={id} />
          ))}

          <s-section>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "7px",
              }}
            >
              <s-icon type="edit" />
              <strong>SEO Templates</strong>
            </span>

            <div
              style={{
                marginTop: "16px",
                display: "grid",
                gap: "14px",
              }}
            >
              <div>
                <label>
                  <strong>SEO Page Title</strong>
                </label>

                <input
                  name="titleTemplate"
                  value={titleTemplate}
                  onChange={(event) => setTitleTemplate(event.target.value)}
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    marginTop: "6px",
                    padding: "10px 12px",
                  }}
                />
              </div>

              <div>
                <label>
                  <strong>Meta Description</strong>
                </label>

                <textarea
                  name="descriptionTemplate"
                  value={descriptionTemplate}
                  onChange={(event) =>
                    setDescriptionTemplate(event.target.value)
                  }
                  rows={3}
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    marginTop: "6px",
                    padding: "10px 12px",
                  }}
                />
              </div>

              <div
                style={{
                  fontSize: "13px",
                  color: "#616161",
                }}
              >
                Available variables: <code>{"{year}"}</code>,{" "}
                <code>{"{make}"}</code>, <code>{"{model}"}</code>,{" "}
                <code>{"{trim}"}</code>, <code>{"{product}"}</code>
              </div>

              <div
                style={{
                  display: "flex",
                  gap: "10px",
                }}
              >
                <button
                  type="submit"
                  name="intent"
                  value="preflight"
                  disabled={busy}
                >
                  Preview / Preflight
                </button>

                <button
                  type="submit"
                  name="intent"
                  value="update"
                  disabled={busy || selectedIds.size === 0}
                  style={{
                    background: "#303030",
                    color: "#ffffff",
                    border: "none",
                    borderRadius: "8px",
                    padding: "10px 15px",
                  }}
                >
                  Update SEO ({selectedIds.size})
                </button>
              </div>
            </div>
          </s-section>

          <div
            style={{
              marginTop: "20px",
            }}
          >
            <s-section heading="YMMT Pages">
              <button
                type="button"
                onClick={() =>
                  setSelectedIds(
                    allSelected
                      ? new Set()
                      : new Set(pages.map((page) => page.id)),
                  )
                }
              >
                {allSelected ? "Deselect All" : "Select All"}
              </button>

              <div
                style={{
                  overflowX: "auto",
                  marginTop: "14px",
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
                        Page
                      </th>

                      <th align="left" style={tableHeaderStyle}>
                        Current SEO Title
                      </th>

                      <th align="left" style={tableHeaderStyle}>
                        Current Description
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
                          <div>
                            <code>{page.handle}</code>
                          </div>
                        </td>

                        <td style={tableCellStyle}>
                          {page.currentSeoTitle || "—"}
                        </td>

                        <td style={tableCellStyle}>
                          {page.currentSeoDescription || "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </s-section>
          </div>
        </Form>

        {actionData?.intent === "preflight" && (
          <s-section heading="SEO Preflight">
            <s-paragraph>
              Pages to update: <strong>{actionData.count}</strong>
            </s-paragraph>

            <div
              style={{
                overflowX: "auto",
                marginTop: "14px",
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
                      Handle
                    </th>

                    <th align="left" style={tableHeaderStyle}>
                      Proposed SEO Title
                    </th>

                    <th align="left" style={tableHeaderStyle}>
                      Proposed Description
                    </th>
                  </tr>
                </thead>

                <tbody>
                  {actionData.preview.slice(0, 100).map((page) => (
                    <tr key={page.id}>
                      <td style={tableCellStyle}>
                        <code>{page.handle}</code>
                      </td>

                      <td style={tableCellStyle}>{page.proposedSeoTitle}</td>

                      <td style={tableCellStyle}>
                        {page.proposedSeoDescription}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </s-section>
        )}

        {actionData?.intent === "update" && (
          <s-section heading="SEO Update Results">
            <s-paragraph>
              Updated: <strong>{actionData.updated}</strong>
              {" · "}
              Failed: <strong>{actionData.failed}</strong>
            </s-paragraph>
          </s-section>
        )}
      </div>
    </s-page>
  );
}
