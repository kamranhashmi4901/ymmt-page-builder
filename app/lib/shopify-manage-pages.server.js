import { buildYMMTPageContent } from "./ymmt-page-content.server";

export async function updateYMMTPageContent(admin, pageId) {
  const response = await admin.graphql(
    `#graphql
      query GetYMMTVehicle($id: ID!) {
        page(id: $id) {
          id

          vehicle: metafield(
            namespace: "ymmt"
            key: "vehicle"
          ) {
            value
          }
        }
      }
    `,
    {
      variables: {
        id: pageId,
      },
    },
  );

  const json = await response.json();

  if (json.errors?.length) {
    throw new Error(json.errors.map((error) => error.message).join(", "));
  }

  const page = json.data?.page;

  if (!page) {
    throw new Error(`Unable to find Shopify page ${pageId}.`);
  }

  if (!page.vehicle?.value) {
    throw new Error("This page does not contain a ymmt.vehicle metafield.");
  }

  let record;

  try {
    record = JSON.parse(page.vehicle.value);
  } catch {
    throw new Error("The ymmt.vehicle metafield contains invalid JSON.");
  }

  const { pageBody } = buildYMMTPageContent(record);

  const updateResponse = await admin.graphql(
    `#graphql
      mutation UpdateYMMTPageContent(
        $id: ID!
        $page: PageUpdateInput!
      ) {
        pageUpdate(
          id: $id
          page: $page
        ) {
          page {
            id
            title
            handle
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
        id: pageId,
        page: {
          body: pageBody,
        },
      },
    },
  );

  const updateJson = await updateResponse.json();

  if (updateJson.errors?.length) {
    throw new Error(updateJson.errors.map((error) => error.message).join(", "));
  }

  const result = updateJson.data?.pageUpdate;

  if (result?.userErrors?.length) {
    throw new Error(result.userErrors.map((error) => error.message).join(", "));
  }

  return result?.page;
}

export async function searchYMMTPages(admin, filters = {}) {
  const pages = [];
  let requestCount = 0;
  const MAX_REQUESTS = 20;
  let cursor = null;
  let hasNextPage = true;

  // const normalized = {
  //   search: String(filters.search || "")
  //     .trim()
  //     .toLowerCase(),
  //   year: String(filters.year || "")
  //     .trim()
  //     .toLowerCase(),
  //   make: String(filters.make || "")
  //     .trim()
  //     .toLowerCase(),
  //   model: String(filters.model || "")
  //     .trim()
  //     .toLowerCase(),
  //   trim: String(filters.trim || "")
  //     .trim()
  //     .toLowerCase(),
  //   manufacturer: String(filters.manufacturer || "")
  //     .trim()
  //     .toLowerCase(),
  //   compatibility: String(filters.compatibility || "")
  //     .trim()
  //     .toLowerCase(),
  //   warning: String(filters.warning || "")
  //     .trim()
  //     .toLowerCase(),
  //   productHandle: String(filters.productHandle || "")
  //     .trim()
  //     .toLowerCase(),
  //   status: String(filters.status || "")
  //     .trim()
  //     .toLowerCase(),
  // };
  const shopifyQueryParts = [];

  if (filters.search) {
    shopifyQueryParts.push(filters.search);
  }

  if (filters.status === "published") {
    shopifyQueryParts.push("published_status:published");
  }

  if (filters.status === "draft") {
    shopifyQueryParts.push("published_status:unpublished");
  }

  const shopifyQuery = shopifyQueryParts.join(" AND ");
  while (hasNextPage) {
    if (requestCount >= MAX_REQUESTS) {
      break;
    }

    requestCount++;
    const response = await admin.graphql(
      `#graphql
          query ManagePages($after: String, $query: String) {
            pages(first: 100, after: $after, query: $query) {
              nodes {
                id
                title
                handle
                templateSuffix
                isPublished

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

                sourceProductHandle: metafield(
                  namespace: "ymmt"
                  key: "source_product_handle"
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
          query: shopifyQuery || null,
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

    for (const page of connection.nodes) {
      /*
       * We treat product-ymmt pages as managed YMMT pages.
       * Search can match either handle or title.
       */
      const isYMMT = page.templateSuffix === "product-ymmt";

      if (!isYMMT) {
        continue;
      }

      let vehicle = {};

      try {
        vehicle = page.vehicle?.value ? JSON.parse(page.vehicle.value) : {};
      } catch {
        vehicle = {};
      }

      const pageData = {
        id: page.id,
        title: page.title,
        handle: page.handle,
        templateSuffix: page.templateSuffix,
        isPublished: page.isPublished,

        productHandle: page.productHandle?.value || "",
        sourceProductHandle: page.sourceProductHandle?.value || "",

        year: String(vehicle.year || ""),
        make: String(vehicle.make || ""),
        model: String(vehicle.model || ""),
        trim: String(vehicle.trim || ""),
        manufacturer: String(vehicle.manufacturer || ""),

        compatibility: String(vehicle.compatible || vehicle.compat || ""),

        warning: String(vehicle.warning || ""),
      };

      const normalize = (value) =>
        String(value || "")
          .trim()
          .toLowerCase();

      const exactMatch = (value, filter) =>
        !normalize(filter) || normalize(value) === normalize(filter);

      const partialMatch = (value, filter) =>
        !normalize(filter) || normalize(value).includes(normalize(filter));

      const matches =
        partialMatch(`${pageData.title} ${pageData.handle}`, filters.search) &&
        exactMatch(pageData.year, filters.year) &&
        partialMatch(pageData.make, filters.make) &&
        partialMatch(pageData.model, filters.model) &&
        partialMatch(pageData.trim, filters.trim) &&
        partialMatch(pageData.manufacturer, filters.manufacturer) &&
        partialMatch(pageData.compatibility, filters.compatibility) &&
        partialMatch(pageData.warning, filters.warning) &&
        partialMatch(pageData.productHandle, filters.productHandle) &&
        (!filters.status ||
          (filters.status === "published" && pageData.isPublished) ||
          (filters.status === "draft" && !pageData.isPublished));

      if (matches) {
        pages.push(pageData);
      }
    }

    hasNextPage = connection.pageInfo.hasNextPage;

    cursor = connection.pageInfo.endCursor;
  }

  return pages;
}

export async function deleteShopifyPage(admin, pageId) {
  const response = await admin.graphql(
    `#graphql
      mutation DeletePage($id: ID!) {
        pageDelete(id: $id) {
          deletedPageId

          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      variables: {
        id: pageId,
      },
    },
  );

  const json = await response.json();

  if (json.errors?.length) {
    throw new Error(json.errors.map((error) => error.message).join(", "));
  }

  const result = json.data?.pageDelete;

  if (result?.userErrors?.length) {
    throw new Error(result.userErrors.map((error) => error.message).join(", "));
  }

  return result?.deletedPageId;
}

export async function updateYMMTProductHandle(
  admin,
  { pageId, productHandle },
) {
  const metafields = [];

  if (productHandle) {
    metafields.push({
      namespace: "ymmt",
      key: "product_handle",
      type: "single_line_text_field",
      value: productHandle,
    });

    metafields.push({
      namespace: "ymmt",
      key: "source_product_handle",
      type: "single_line_text_field",
      value: productHandle,
    });
  }

  const page = {
    templateSuffix: "product-ymmt",
  };

  if (metafields.length > 0) {
    page.metafields = metafields;
  }

  const response = await admin.graphql(
    `#graphql
      mutation UpdatePage(
        $id: ID!
        $page: PageUpdateInput!
      ) {
        pageUpdate(
          id: $id
          page: $page
        ) {
          page {
            id
            title
            handle
            templateSuffix
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
        id: pageId,
        page,
      },
    },
  );

  const json = await response.json();

  if (json.errors?.length) {
    throw new Error(json.errors.map((error) => error.message).join(", "));
  }

  const result = json.data?.pageUpdate;

  if (result?.userErrors?.length) {
    throw new Error(result.userErrors.map((error) => error.message).join(", "));
  }

  return result?.page;
}

export async function getShopifyPageSnapshot(admin, pageId) {
  const response = await admin.graphql(
    `#graphql
      query GetPageSnapshot($id: ID!) {
        page(id: $id) {
          id
          title
          handle
          body
          templateSuffix
          isPublished
          publishedAt

          metafields(first: 50, namespace: "ymmt") {
            nodes {
              id
              namespace
              key
              type
              value
            }
          }
        }
      }
    `,
    {
      variables: {
        id: pageId,
      },
    },
  );

  const json = await response.json();

  if (json.errors?.length) {
    throw new Error(json.errors.map((error) => error.message).join(", "));
  }

  if (!json.data?.page) {
    throw new Error(`Unable to find Shopify page ${pageId}.`);
  }

  return json.data.page;
}
