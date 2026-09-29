import { buildYMMTPageContent } from "./ymmt-page-content.server";

export async function createYMMTPage(
  admin,
  { title, handle, record, sourceProductHandle },
) {
  const { vehicle, pageBody } = buildYMMTPageContent(record);

  const fallbackUrl = sourceProductHandle
    ? `/products/${sourceProductHandle}`
    : "";

  const response = await admin.graphql(
    `#graphql
      mutation CreateYMMTPage($page: PageCreateInput!) {
        pageCreate(page: $page) {
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
        page: {
          title,
          handle,
          isPublished: true,
          templateSuffix: "product-ymmt",

          body: pageBody,

          metafields: [
            {
              namespace: "ymmt",
              key: "source_product_handle",
              type: "single_line_text_field",
              value: sourceProductHandle || "",
            },
            {
              namespace: "ymmt",
              key: "product_handle",
              type: "single_line_text_field",
              value: sourceProductHandle || "",
            },
            {
              namespace: "ymmt",
              key: "embed_kind",
              type: "single_line_text_field",
              value: sourceProductHandle ? "product" : "collection",
            },
            {
              namespace: "ymmt",
              key: "fallback_url",
              type: "single_line_text_field",
              value: fallbackUrl,
            },
            {
              namespace: "ymmt",
              key: "vehicle",
              type: "json",
              value: JSON.stringify(vehicle),
            },
          ],
        },
      },
    },
  );

  const json = await response.json();

  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join(", "));
  }

  const result = json.data?.pageCreate;

  if (result?.userErrors?.length) {
    throw new Error(result.userErrors.map((e) => e.message).join(", "));
  }

  if (!result?.page) {
    throw new Error("Shopify did not return the created page.");
  }

  return result.page;
}
