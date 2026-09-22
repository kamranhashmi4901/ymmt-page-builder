export async function searchYMMTPages(admin, search = "") {
  const pages = [];
  let cursor = null;
  let hasNextPage = true;

  const normalizedSearch = String(search || "")
    .trim()
    .toLowerCase();

  while (hasNextPage) {
    const response = await admin.graphql(
      `#graphql
        query ManagePages($after: String) {
          pages(first: 100, after: $after) {
            nodes {
              id
              title
              handle
              templateSuffix
              isPublished

              metafield(
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

    for (const page of connection.nodes) {
      /*
       * We treat product-ymmt pages as managed YMMT pages.
       * Search can match either handle or title.
       */
      const isYMMT = page.templateSuffix === "product-ymmt";

      if (!isYMMT) {
        continue;
      }

      const matches =
        !normalizedSearch ||
        page.handle?.toLowerCase().includes(normalizedSearch) ||
        page.title?.toLowerCase().includes(normalizedSearch);

      if (matches) {
        pages.push({
          id: page.id,
          title: page.title,
          handle: page.handle,
          templateSuffix: page.templateSuffix,
          isPublished: page.isPublished,
          productHandle: page.metafield?.value || "",
        });
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

export async function updateYMMTPage(admin, { pageId, productHandle }) {
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
