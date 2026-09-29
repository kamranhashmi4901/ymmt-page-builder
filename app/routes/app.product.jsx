import { useState } from "react";
import {
  Form,
  Link,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";

import { authenticate } from "../shopify.server";

import { getYMMTUpload, setSourceProducts } from "../lib/ymmt-uploads.server";

import {
  UploadIcon,
  ProductIcon,
  FilterIcon,
  CheckCircleIcon,
  PageAddIcon,
} from "@shopify/polaris-icons";

/* =========================================================
   LOADER
   ---------------------------------------------------------
   Loads:
   - current YMMT upload
   - products already selected for this upload
   - Shopify product search results
========================================================= */

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);

  const url = new URL(request.url);

  const uploadId = url.searchParams.get("uploadId");

  const search = url.searchParams.get("search")?.trim() || "";

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

  let products = [];

  /*
   * Only search Shopify when the user
   * actually enters a product search.
   */
  if (search) {
    const response = await admin.graphql(
      `#graphql
        query SearchProducts($query: String!) {
          products(
            first: 20
            query: $query
          ) {
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
          query: search,
        },
      },
    );

    const json = await response.json();

    if (json.errors?.length) {
      throw new Error(json.errors.map((error) => error.message).join(", "));
    }

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

      /*
       * These products come from Prisma.
       *
       * There is no fixed limit.
       */
      sourceProducts: upload.sourceProducts || [],
    },

    products,

    search,
  };
};

/* =========================================================
   ACTION
   ---------------------------------------------------------
   Saves the selected products for this YMMT upload.
========================================================= */

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  const formData = await request.formData();

  const uploadId = String(formData.get("uploadId") || "");

  const mode = String(formData.get("mode") || "");

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

  /* =====================================================
     SKIP PRODUCT SUFFIX
  ===================================================== */

  if (mode === "skip") {
    await setSourceProducts({
      uploadId,
      shop: session.shop,
      products: [],
    });

    return redirect(`/app/filter?uploadId=${encodeURIComponent(uploadId)}`);
  }

  /* =====================================================
     SAVE SELECTED PRODUCTS
  ===================================================== */

  if (mode !== "select") {
    return {
      success: false,
      error: "Unknown product action.",
    };
  }

  const rawProducts = formData.getAll("selectedProducts");

  let selectedProducts = [];

  try {
    selectedProducts = rawProducts.map((value) => {
      const product = JSON.parse(String(value));

      return {
        productId: String(product.productId || ""),

        title: String(product.title || ""),

        handle: String(product.handle || "")
          .trim()
          .toLowerCase(),
      };
    });
  } catch {
    return {
      success: false,
      error: "Unable to read selected products.",
    };
  }

  /*
   * Remove empty handles.
   */
  selectedProducts = selectedProducts.filter((product) => product.handle);

  /*
   * Remove duplicate products.
   */
  selectedProducts = Array.from(
    new Map(
      selectedProducts.map((product) => [product.handle, product]),
    ).values(),
  );

  if (selectedProducts.length === 0) {
    return {
      success: false,
      error: "Please select at least one product.",
    };
  }

  /*
   * Shopify product handles should
   * contain lowercase letters,
   * numbers and hyphens.
   */
  const invalid = selectedProducts.find(
    (product) => !/^[a-z0-9-]+$/.test(product.handle),
  );

  if (invalid) {
    return {
      success: false,

      error: `Invalid product handle: ${invalid.handle}`,
    };
  }

  await setSourceProducts({
    uploadId,
    shop: session.shop,
    products: selectedProducts,
  });

  return redirect(`/app/filter?uploadId=${encodeURIComponent(uploadId)}`);
};

/* =========================================================
   PAGE STEP INDICATOR
========================================================= */

const steps = [
  {
    label: "Upload Data",

    icon: UploadIcon,
  },

  {
    label: "Select Products",

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

const cardStyle = {
  background: "#ffffff",

  border: "1px solid #e3e3e3",

  borderRadius: "12px",

  padding: "18px",
};

const primaryButtonStyle = {
  padding: "10px 16px",

  borderRadius: "8px",

  border: "none",

  background: "#303030",

  color: "#ffffff",

  fontWeight: "650",

  cursor: "pointer",
};

/* =========================================================
   COMPONENT
========================================================= */

export default function ProductSelection() {
  const { upload, products, search } = useLoaderData();

  const actionData = useActionData();

  const navigation = useNavigation();

  const isSubmitting = navigation.state === "submitting";

  const [showPicker, setShowPicker] = useState(Boolean(search));

  /*
   * Map is useful here because:
   *
   * handle -> product
   *
   * automatically gives us fast
   * duplicate-free product selection.
   */
  const [selectedProducts, setSelectedProducts] = useState(() => {
    return new Map(
      (upload.sourceProducts || []).map((product) => [
        product.handle,

        {
          productId: product.productId || "",

          title: product.title || product.handle,

          handle: product.handle,
        },
      ]),
    );
  });

  const toggleProduct = (product) => {
    setSelectedProducts((current) => {
      const next = new Map(current);

      if (next.has(product.handle)) {
        next.delete(product.handle);
      } else {
        next.set(
          product.handle,

          {
            productId: product.id,

            title: product.title,

            handle: product.handle,
          },
        );
      }

      return next;
    });
  };

  const removeProduct = (handle) => {
    setSelectedProducts((current) => {
      const next = new Map(current);

      next.delete(handle);

      return next;
    });
  };

  const selectedProductList = Array.from(selectedProducts.values());

  return (
    <s-page heading="Create YMMT Pages">
      <div
        style={{
          display: "flex",

          flexDirection: "column",

          gap: "24px",
        }}
      >
        {/* =================================================
            WORKFLOW STEPS
        ================================================= */}

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

            const isActive = index === 1;

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

                    borderRadius: "9px",

                    border: isActive
                      ? "1px solid #303030"
                      : "1px solid #d8d8d8",

                    background: isActive ? "#303030" : "#ffffff",

                    color: isActive ? "#ffffff" : "#616161",

                    fontWeight: isActive ? "650" : "500",
                  }}
                >
                  <span
                    style={{
                      width: "16px",

                      height: "16px",

                      display: "inline-flex",

                      fill: isActive ? "#ffffff" : "#616161",
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

        {/* =================================================
            CURRENT UPLOAD
        ================================================= */}

        <s-section>
          <strong>Current YMMT Upload</strong>

          <div
            style={{
              marginTop: "14px",

              display: "grid",

              gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",

              gap: "12px",
            }}
          >
            <div style={cardStyle}>
              <div>File</div>

              <strong>{upload.fileName}</strong>
            </div>

            <div style={cardStyle}>
              <div>Records</div>

              <strong>{upload.totalRecords}</strong>
            </div>

            <div style={cardStyle}>
              <div>Makes</div>

              <strong>{upload.totalMakes}</strong>
            </div>

            <div style={cardStyle}>
              <div>Models</div>

              <strong>{upload.totalModels}</strong>
            </div>
          </div>
        </s-section>

        {/* =================================================
            PRODUCT SELECTION
        ================================================= */}

        <div
          style={{
            display: "grid",

            gridTemplateColumns: "minmax(0, 2fr) minmax(280px, 1fr)",

            gap: "20px",

            alignItems: "start",
          }}
        >
          <s-section>
            <strong>Select Product Handles</strong>

            <s-paragraph>
              Select one or more Shopify products. The app will create one YMMT
              page for each selected vehicle and product combination.
            </s-paragraph>

            {/* =============================================
                CURRENT PRODUCT SELECTION
            ============================================= */}

            {selectedProductList.length > 0 && (
              <div
                style={{
                  marginTop: "16px",

                  padding: "14px",

                  background: "#f4f6f8",

                  border: "1px solid #dedede",

                  borderRadius: "10px",
                }}
              >
                <strong>
                  Selected Products ({selectedProductList.length})
                </strong>

                <div
                  style={{
                    marginTop: "10px",

                    display: "flex",

                    flexWrap: "wrap",

                    gap: "8px",
                  }}
                >
                  {selectedProductList.map((product) => (
                    <button
                      key={product.handle}

                      type="button"

                      onClick={() => removeProduct(product.handle)}

                      style={{
                        padding: "7px 10px",

                        borderRadius: "999px",

                        border: "1px solid #c9c9c9",

                        background: "#ffffff",

                        cursor: "pointer",
                      }}
                    >
                      {product.title} ×
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* =============================================
                OPEN PRODUCT PICKER
            ============================================= */}

            {!showPicker && (
              <div
                style={{
                  marginTop: "20px",

                  display: "flex",

                  gap: "10px",
                }}
              >
                <button
                  type="button"

                  onClick={() => setShowPicker(true)}

                  style={primaryButtonStyle}
                >
                  Select Products
                </button>

                <Form method="post">
                  <input
                    type="hidden"

                    name="uploadId"

                    value={upload.id}
                  />

                  <button
                    type="submit"
                    name="mode"
                    value="skip"
                    style={{
                      padding: "9px 14px",
                      borderRadius: "8px",
                      border: "1px solid #c9c9c9",
                      background: "#ffffff",
                      fontWeight: "650",
                      cursor: "pointer",
                    }}
                    disabled={isSubmitting}
                  >
                    Skip — No Product Suffix
                  </button>
                </Form>
              </div>
            )}

            {/* =============================================
                PRODUCT PICKER
            ============================================= */}

            {showPicker && (
              <div
                style={{
                  marginTop: "20px",
                }}
              >
                <div
                  style={{
                    padding: "18px",

                    border: "1px solid #dedede",

                    borderRadius: "12px",

                    background: "#fafafa",
                  }}
                >
                  <strong>Search Shopify Products</strong>

                  <Form method="get">
                    <input
                      type="hidden"

                      name="uploadId"

                      value={upload.id}
                    />

                    <div
                      style={{
                        marginTop: "10px",

                        display: "flex",

                        gap: "8px",
                      }}
                    >
                      <input
                        type="text"

                        name="search"

                        defaultValue={search}

                        placeholder="Search by product title..."

                        style={{
                          flex: "1",

                          padding: "10px",

                          border: "1px solid #c9c9c9",

                          borderRadius: "8px",
                        }}
                      />

                      <button
                        type="submit"

                        style={primaryButtonStyle}
                      >
                        Search
                      </button>
                    </div>
                  </Form>

                  {search && products.length === 0 && (
                    <div
                      style={{
                        marginTop: "14px",
                      }}
                    >
                      No products found.
                    </div>
                  )}

                  {products.length > 0 && (
                    <div
                      style={{
                        marginTop: "16px",

                        display: "flex",

                        flexDirection: "column",

                        gap: "8px",
                      }}
                    >
                      {products.map((product) => {
                        const selected = selectedProducts.has(product.handle);

                        return (
                          <div
                            key={product.id}
                            style={{
                              padding: "13px",
                              display: "flex",
                              alignItems: "center",
                              gap: "12px",
                              borderRadius: "10px",
                              border: selected
                                ? "1px solid #303030"
                                : "1px solid #e3e3e3",
                              background: selected ? "#f4f7ff" : "#ffffff",
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={selected}
                              onChange={() => toggleProduct(product)}
                              aria-label={`Select ${product.title}`}
                            />

                            <div>
                              <strong>{product.title}</strong>

                              <div
                                style={{
                                  fontSize: "13px",
                                  color: "#616161",
                                  marginTop: "3px",
                                }}
                              >
                                {product.handle} · {product.status}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* =========================================
                    SAVE ALL SELECTED PRODUCTS
                ========================================= */}

                <Form method="post">
                  <input
                    type="hidden"

                    name="uploadId"

                    value={upload.id}
                  />

                  <input
                    type="hidden"

                    name="mode"

                    value="select"
                  />

                  {selectedProductList.map((product) => (
                    <input
                      key={product.handle}

                      type="hidden"

                      name="selectedProducts"

                      value={JSON.stringify(product)}
                    />
                  ))}

                  <div
                    style={{
                      marginTop: "16px",

                      display: "flex",

                      justifyContent: "space-between",

                      alignItems: "center",
                    }}
                  >
                    <div>
                      {selectedProductList.length} product
                      {selectedProductList.length === 1 ? "" : "s"} selected
                    </div>

                    <button
                      type="submit"

                      disabled={
                        isSubmitting || selectedProductList.length === 0
                      }

                      style={primaryButtonStyle}
                    >
                      {isSubmitting ? "Saving..." : "Save Selected Products"}
                    </button>
                  </div>
                </Form>
              </div>
            )}

            {/* =============================================
                ERROR
            ============================================= */}

            {actionData?.error && (
              <div
                style={{
                  marginTop: "18px",

                  padding: "14px",

                  background: "#fff4f4",

                  border: "1px solid #f1b8b8",

                  borderRadius: "10px",
                }}
              >
                {actionData.error}
              </div>
            )}

            {/* =============================================
                SUCCESS / CONTINUE
            ============================================= */}

            {actionData?.success && (
              <div
                style={{
                  marginTop: "18px",

                  padding: "14px",

                  background: "#f1fff2",

                  border: "1px solid #b7ddb9",

                  borderRadius: "10px",
                }}
              >
                <strong>
                  {actionData.skipped
                    ? "No product suffix selected."
                    : `${actionData.products?.length || 0} products selected.`}
                </strong>

                {!actionData.skipped && actionData.products?.length > 0 && (
                  <div
                    style={{
                      marginTop: "8px",
                    }}
                  >
                    {actionData.products
                      .map((product) => product.handle)
                      .join(", ")}
                  </div>
                )}

                <div
                  style={{
                    marginTop: "12px",
                  }}
                >
                  <Link
                    to={`/app/filter?uploadId=${encodeURIComponent(
                      actionData.uploadId,
                    )}`}

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
                    Continue to Filter & Preview →
                  </Link>
                </div>
              </div>
            )}
          </s-section>

          {/* =================================================
              EXPLANATION
          ================================================= */}

          <div
            style={{
              background: "#ffffff",

              border: "1px solid #e3e3e3",

              borderRadius: "12px",

              padding: "20px",
            }}
          >
            <strong>How Multiple Products Work</strong>

            <p>
              One vehicle will generate one page for every selected product.
            </p>

            <div
              style={{
                padding: "12px",

                background: "#f6f6f7",

                borderRadius: "8px",
              }}
            >
              <code>
                2027-toyota-land-cruiser-base-triquilt-seat-covers
                <br />
                2027-toyota-land-cruiser-base-luxiline-seat-cover
                <br />
                2027-toyota-land-cruiser-base-silverstone-seat-cover
              </code>
            </div>

            <p>
              The products above are only examples. The app does not limit
              selection to any specific product.
            </p>
          </div>
        </div>

        <div>
          <Link to="/app/upload">← Back to Upload</Link>
        </div>
      </div>
    </s-page>
  );
}
