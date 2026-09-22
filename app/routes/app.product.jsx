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
          query: search,
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

const cardStyle = {
  background: "#ffffff",
  border: "1px solid #e3e3e3",
  borderRadius: "12px",
  padding: "18px",
};

export default function ProductSelection() {
  const { upload, products, search } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();

  const [showPicker, setShowPicker] = useState(Boolean(search));

  const isSubmitting = navigation.state === "submitting";

  return (
    <s-page heading="Create YMMT Pages">
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "24px",
        }}
      >
        {/* Workflow steps */}
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

        {/* Upload summary */}
        <s-section>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "7px",
            }}
          >
            <s-icon type="upload" />
            <strong>Current YMMT Upload</strong>
          </span>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
              gap: "12px",
            }}
          >
            <div style={cardStyle}>
              <div style={{ color: "#616161", fontSize: "13px" }}>File</div>
              <div
                style={{
                  marginTop: "5px",
                  fontWeight: "650",
                  wordBreak: "break-word",
                }}
              >
                {upload.fileName}
              </div>
            </div>

            <div style={cardStyle}>
              <div style={{ color: "#616161", fontSize: "13px" }}>Records</div>
              <div
                style={{
                  fontSize: "22px",
                  marginTop: "5px",
                  fontWeight: "700",
                }}
              >
                {upload.totalRecords}
              </div>
            </div>

            <div style={cardStyle}>
              <div style={{ color: "#616161", fontSize: "13px" }}>Makes</div>
              <div
                style={{
                  fontSize: "22px",
                  marginTop: "5px",
                  fontWeight: "700",
                }}
              >
                {upload.totalMakes}
              </div>
            </div>

            <div style={cardStyle}>
              <div style={{ color: "#616161", fontSize: "13px" }}>Models</div>
              <div
                style={{
                  fontSize: "22px",
                  marginTop: "5px",
                  fontWeight: "700",
                }}
              >
                {upload.totalModels}
              </div>
            </div>
          </div>
        </s-section>

        {/* Main product selector */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 2fr) minmax(280px, 1fr)",
            gap: "20px",
            alignItems: "start",
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
              <s-icon type="product" />
              <strong>Select Product Handle</strong>
            </span>
            <s-paragraph>
              Choose the Shopify product handle that should be appended to
              generated YMMT page URLs.
            </s-paragraph>

            {upload.sourceProductHandle && (
              <div
                style={{
                  marginTop: "16px",
                  padding: "12px 14px",
                  background: "#f4f6f8",
                  border: "1px solid #dedede",
                  borderRadius: "10px",
                }}
              >
                Current product: <strong>{upload.sourceProductHandle}</strong>
              </div>
            )}

            {!showPicker && (
              <div
                style={{
                  marginTop: "20px",
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "10px",
                }}
              >
                <s-button
                  type="button"
                  onClick={() => setShowPicker(true)}
                  style={{
                    padding: "10px 18px",
                    borderRadius: "8px",
                    border: "none",
                    background: "#303030",
                    color: "#ffffff",
                    fontWeight: "650",
                    cursor: "pointer",
                  }}
                  icon="product"
                >
                  Select Product
                </s-button>

                <Form method="post">
                  <input type="hidden" name="uploadId" value={upload.id} />

                  <button
                    type="submit"
                    name="mode"
                    value="skip"
                    disabled={isSubmitting}
                    style={{
                      padding: "10px 18px",
                      borderRadius: "8px",
                      border: "1px solid #c9c9c9",
                      background: "#ffffff",
                      cursor: "pointer",
                    }}
                  >
                    Skip — No Product Suffix
                  </button>
                </Form>
              </div>
            )}

            {showPicker && (
              <div style={{ marginTop: "20px" }}>
                <div
                  style={{
                    padding: "18px",
                    border: "1px solid #dedede",
                    borderRadius: "12px",
                    background: "#fafafa",
                  }}
                >
                  <div
                    style={{
                      fontWeight: "650",
                      marginBottom: "10px",
                    }}
                  >
                    Search Shopify Products
                  </div>

                  <Form method="get">
                    <input type="hidden" name="uploadId" value={upload.id} />

                    <div
                      style={{
                        display: "flex",
                        gap: "8px",
                        flexWrap: "wrap",
                      }}
                    >
                      <input
                        type="text"
                        name="search"
                        defaultValue={search}
                        placeholder="Search by product title..."
                        style={{
                          flex: "1 1 280px",
                          padding: "10px 12px",
                          border: "1px solid #c9c9c9",
                          borderRadius: "8px",
                          fontSize: "14px",
                        }}
                      />

                      <s-button
                        type="submit"
                        style={{
                          padding: "10px 16px",
                          borderRadius: "8px",
                          border: "none",
                          background: "#303030",
                          color: "#ffffff",
                          fontWeight: "650",
                        }}
                        icon="search"
                      >
                        Search
                      </s-button>
                    </div>
                  </Form>

                  {search && products.length === 0 && (
                    <div
                      style={{
                        marginTop: "14px",
                        color: "#616161",
                      }}
                    >
                      No products found for “{search}”.
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
                      {products.map((product) => (
                        <Form method="post" key={product.id}>
                          <input
                            type="hidden"
                            name="uploadId"
                            value={upload.id}
                          />

                          <input
                            type="hidden"
                            name="productHandle"
                            value={product.handle}
                          />

                          <div
                            style={{
                              background: "#ffffff",
                              border: "1px solid #e3e3e3",
                              borderRadius: "10px",
                              padding: "13px 14px",
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                              gap: "14px",
                            }}
                          >
                            <div>
                              <div
                                style={{
                                  fontWeight: "650",
                                  marginBottom: "3px",
                                }}
                              >
                                {product.title}
                              </div>

                              <div
                                style={{
                                  color: "#616161",
                                  fontSize: "13px",
                                }}
                              >
                                {product.handle}
                                {" · "}
                                {product.status}
                              </div>
                            </div>

                            <button
                              type="submit"
                              name="mode"
                              value="select"
                              disabled={isSubmitting}
                              style={{
                                padding: "8px 14px",
                                borderRadius: "8px",
                                border: "1px solid #c9c9c9",
                                background: "#ffffff",
                                fontWeight: "600",
                                cursor: "pointer",
                              }}
                            >
                              Select
                            </button>
                          </div>
                        </Form>
                      ))}
                    </div>
                  )}
                </div>

                {/* Manual handle */}
                <div style={{ marginTop: "18px" }}>
                  <div
                    style={{
                      fontWeight: "650",
                      marginBottom: "8px",
                    }}
                  >
                    Or enter handle manually
                  </div>

                  <Form method="post">
                    <input type="hidden" name="uploadId" value={upload.id} />

                    <div
                      style={{
                        display: "flex",
                        gap: "8px",
                        flexWrap: "wrap",
                      }}
                    >
                      <input
                        type="text"
                        name="productHandle"
                        defaultValue={upload.sourceProductHandle || ""}
                        placeholder="triquilt-seat-covers"
                        style={{
                          flex: "1 1 280px",
                          padding: "10px 12px",
                          border: "1px solid #c9c9c9",
                          borderRadius: "8px",
                        }}
                      />

                      <button
                        type="submit"
                        name="mode"
                        value="select"
                        disabled={isSubmitting}
                        style={{
                          padding: "10px 16px",
                          borderRadius: "8px",
                          border: "none",
                          background: "#303030",
                          color: "#ffffff",
                          fontWeight: "650",
                        }}
                      >
                        Confirm Product
                      </button>
                    </div>
                  </Form>

                  <div
                    style={{
                      marginTop: "7px",
                      color: "#777",
                      fontSize: "12px",
                    }}
                  >
                    Use lowercase letters, numbers and hyphens only.
                  </div>
                </div>

                <div style={{ marginTop: "18px" }}>
                  <Form method="post">
                    <input type="hidden" name="uploadId" value={upload.id} />

                    <button
                      type="submit"
                      name="mode"
                      value="skip"
                      disabled={isSubmitting}
                      style={{
                        padding: "9px 14px",
                        borderRadius: "8px",
                        border: "1px solid #c9c9c9",
                        background: "#ffffff",
                      }}
                    >
                      Skip — No Product Suffix
                    </button>
                  </Form>
                </div>
              </div>
            )}

            {actionData?.error && (
              <div
                style={{
                  marginTop: "18px",
                  border: "1px solid #f1b8b8",
                  background: "#fff4f4",
                  borderRadius: "10px",
                  padding: "14px",
                }}
              >
                {actionData.error}
              </div>
            )}

            {actionData?.success && (
              <div
                style={{
                  marginTop: "18px",
                  border: "1px solid #b7ddb9",
                  background: "#f1fff2",
                  borderRadius: "10px",
                  padding: "14px",
                }}
              >
                <div style={{ fontWeight: "650" }}>
                  {actionData.productHandle
                    ? `Selected product: ${actionData.productHandle}`
                    : "No product suffix selected."}
                </div>

                <div style={{ marginTop: "12px" }}>
                  <Link
                    to={`/app/filter?uploadId=${encodeURIComponent(
                      actionData.uploadId,
                    )}`}
                    style={{
                      display: "inline-block",
                      padding: "10px 16px",
                      borderRadius: "8px",
                      background: "#303030",
                      color: "#ffffff",
                      textDecoration: "none",
                      fontWeight: "650",
                    }}
                  >
                    Continue to Filter & Preview →
                  </Link>
                </div>
              </div>
            )}
          </s-section>

          {/* Right-side explanation */}
          <div
            style={{
              background: "#ffffff",
              border: "1px solid #e3e3e3",
              borderRadius: "12px",
              padding: "20px",
            }}
          >
            <div
              style={{
                fontSize: "17px",
                fontWeight: "650",
                marginBottom: "10px",
              }}
            >
              How Handles Work
            </div>

            <div
              style={{
                color: "#616161",
                lineHeight: "1.55",
                fontSize: "14px",
              }}
            >
              The selected product handle is appended to each generated vehicle
              page URL.
            </div>

            <div
              style={{
                marginTop: "18px",
                padding: "12px",
                background: "#f6f6f7",
                borderRadius: "8px",
              }}
            >
              <div
                style={{
                  fontSize: "12px",
                  color: "#777",
                  marginBottom: "5px",
                }}
              >
                WITH PRODUCT HANDLE
              </div>

              <code
                style={{
                  fontSize: "12px",
                  wordBreak: "break-word",
                }}
              >
                2027-toyota-land-cruiser-base-triquilt-seat-covers
              </code>
            </div>

            <div
              style={{
                marginTop: "10px",
                padding: "12px",
                background: "#f6f6f7",
                borderRadius: "8px",
              }}
            >
              <div
                style={{
                  fontSize: "12px",
                  color: "#777",
                  marginBottom: "5px",
                }}
              >
                WITHOUT PRODUCT SUFFIX
              </div>

              <code
                style={{
                  fontSize: "12px",
                  wordBreak: "break-word",
                }}
              >
                2027-toyota-land-cruiser-base
              </code>
            </div>

            <div
              style={{
                marginTop: "18px",
                fontSize: "13px",
                color: "#616161",
              }}
            >
              The selected source handle is saved with this upload and used when
              proposed page handles are generated during Filter and Review.
            </div>
          </div>
        </div>

        <div>
          <Link
            to="/app/upload"
            style={{
              color: "#616161",
              textDecoration: "none",
              fontWeight: "600",
            }}
          >
            ← Back to Upload
          </Link>
        </div>
      </div>
    </s-page>
  );
}
