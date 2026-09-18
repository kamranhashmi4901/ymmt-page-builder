import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";

import { authenticate } from "../shopify.server";
import {
  getYMMTUpload,
  setSourceProductHandle,
} from "../lib/ymmt-uploads.server";

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);

  const url = new URL(request.url);
  const uploadId = url.searchParams.get("uploadId");
  const search = url.searchParams.get("search")?.trim() || "";

  if (!uploadId) {
    throw new Response("Upload ID is required.", { status: 400 });
  }

  const upload = await getYMMTUpload({
    uploadId,
    shop: session.shop,
  });

  if (!upload) {
    throw new Response("YMMT upload not found.", { status: 404 });
  }

  let products = [];

  if (search) {
    const response = await admin.graphql(
      `#graphql
        query SearchProducts($query: String!) {
          products(first: 20, query: $query) {
            nodes {
              id
              title
              handle
              status
            }
          }
        }
      `,
      {
        variables: {
          query: `title:${search}`,
        },
      },
    );

    const json = await response.json();

    products = json.data?.products?.nodes || [];
  }

  return {
    upload: {
      id: upload.id,
      fileName: upload.fileName,
      totalRecords: upload.totalRecords,
      totalYears: upload.totalYears,
      totalMakes: upload.totalMakes,
      totalModels: upload.totalModels,
      totalTrims: upload.totalTrims,
      sourceProductHandle: upload.sourceProductHandle,
    },
    products,
    search,
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  const formData = await request.formData();

  const uploadId = formData.get("uploadId");
  const mode = formData.get("mode");

  if (!uploadId) {
    return {
      success: false,
      error: "Upload ID is required.",
    };
  }

  const upload = await getYMMTUpload({
    uploadId,
    shop: session.shop,
  });

  if (!upload) {
    return {
      success: false,
      error: "YMMT upload not found.",
    };
  }

  let handle = null;

  if (mode !== "skip") {
    handle = String(formData.get("productHandle") || "")
      .trim()
      .toLowerCase();

    if (!handle) {
      return {
        success: false,
        error: "Please select or enter a product handle.",
      };
    }

    if (!/^[a-z0-9-]+$/.test(handle)) {
      return {
        success: false,
        error:
          "Product handle can only contain lowercase letters, numbers, and hyphens.",
      };
    }
  }

  await setSourceProductHandle({
    uploadId,
    shop: session.shop,
    sourceProductHandle: handle,
  });

  return {
    success: true,
    uploadId,
    productHandle: handle,
  };
};

export default function ProductSelection() {
  const { upload, products, search } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();

  const isSubmitting = navigation.state === "submitting";

  return (
    <s-page heading="Select Product Handle">
      <s-section heading="YMMT Upload">
        <s-paragraph>
          File: <strong>{upload.fileName}</strong>
          {" · "}
          Records: <strong>{upload.totalRecords}</strong>
        </s-paragraph>
      </s-section>

      <s-section heading="Search Your Shopify Products">
        <Form method="get">
          <input type="hidden" name="uploadId" value={upload.id} />

          <input
            type="text"
            name="search"
            defaultValue={search}
            placeholder="e.g. seat covers, triquilt..."
          />

          <button type="submit">Search</button>
        </Form>

        {products.length > 0 && (
          <div style={{ marginTop: "16px" }}>
            {products.map((product) => (
              <Form method="post" key={product.id}>
                <input type="hidden" name="uploadId" value={upload.id} />
                <input
                  type="hidden"
                  name="productHandle"
                  value={product.handle}
                />

                <div style={{ marginBottom: "12px" }}>
                  <strong>{product.title}</strong>
                  <div>{product.handle}</div>

                  <button type="submit" name="mode" value="select">
                    Select
                  </button>
                </div>
              </Form>
            ))}
          </div>
        )}
      </s-section>

      <s-section heading="Or Enter Handle Manually">
        <Form method="post">
          <input type="hidden" name="uploadId" value={upload.id} />

          <input
            type="text"
            name="productHandle"
            defaultValue={upload.sourceProductHandle || ""}
            placeholder="triquilt-seat-covers"
          />

          <button
            type="submit"
            name="mode"
            value="select"
            disabled={isSubmitting}
          >
            Confirm Product
          </button>
        </Form>
      </s-section>

      <s-section heading="No Product Suffix">
        <Form method="post">
          <input type="hidden" name="uploadId" value={upload.id} />

          <button
            type="submit"
            name="mode"
            value="skip"
            disabled={isSubmitting}
          >
            Skip — No Product Suffix
          </button>
        </Form>
      </s-section>

      {actionData?.error && (
        <s-section heading="Error">
          <s-paragraph>{actionData.error}</s-paragraph>
        </s-section>
      )}

      {actionData?.success && (
        <s-section heading="Product Saved">
          <s-paragraph>
            {actionData.productHandle
              ? `Selected: ${actionData.productHandle}`
              : "No product suffix selected."}
          </s-paragraph>

          <a href={`/app/filter?uploadId=${actionData.uploadId}`}>
            Continue to Filter & Preview
          </a>
        </s-section>
      )}
    </s-page>
  );
}
