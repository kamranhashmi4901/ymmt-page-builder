import {
  Form,
  Link,
  redirect,
  useLoaderData,
  useNavigation,
} from "react-router";

import db from "../db.server";

import { createYMMTJob, startYMMTJobProcessor } from "../lib/ymmt-jobs.server";

import { authenticate } from "../shopify.server";

import { getYMMTUpload } from "../lib/ymmt-uploads.server";

import { getExistingPageHandles } from "../lib/shopify-pages.server";

import { buildYMMTPageHandle } from "../lib/ymmt-pages";

function buildRecordHandles(record, upload) {
  const sourceProducts =
    upload.sourceProducts?.length > 0 ? upload.sourceProducts : [null];

  return sourceProducts.map((product) =>
    buildYMMTPageHandle(record, product?.handle || null),
  );
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

  const selectedRecords = await db.ymmtRecord.findMany({
    where: {
      uploadId,

      selected: true,

      duplicate: false,
    },
  });

  /*
   * Build only the final Shopify handles
   * that this creation batch needs.
   */
  const candidateHandles = selectedRecords.flatMap((record) =>
    buildRecordHandles(record, upload),
  );

  /*
   * Targeted duplicate lookup.
   *
   * No full-store page scan.
   */
  const existingHandles = await getExistingPageHandles(admin, candidateHandles);

  let pageCount = 0;

  let skippedExistingCount = 0;

  for (const record of selectedRecords) {
    const handles = buildRecordHandles(record, upload);

    for (const handle of handles) {
      if (existingHandles.has(handle)) {
        skippedExistingCount += 1;
      } else {
        pageCount += 1;
      }
    }
  }

  return {
    upload,

    selectedCount: selectedRecords.length,

    pageCount,

    skippedExistingCount,

    productCount:
      upload.sourceProducts?.length > 0 ? upload.sourceProducts.length : 1,
  };
};

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);

  const formData = await request.formData();

  const uploadId = String(formData.get("uploadId") || "");

  const upload = await getYMMTUpload({
    uploadId,

    shop: session.shop,
  });

  if (!upload) {
    throw new Response("YMMT upload not found.", {
      status: 404,
    });
  }

  const job = await createYMMTJob({
    shop: session.shop,

    uploadId,
  });

  startYMMTJobProcessor({
    jobId: job.id,

    shop: session.shop,

    admin,
  });

  return redirect(`/app/job/${job.id}`);
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

const summaryCardStyle = {
  background: "#ffffff",

  border: "1px solid #e3e3e3",

  borderRadius: "12px",

  padding: "16px",
};

export default function CreatePages() {
  const {
    upload,
    selectedCount,
    pageCount,
    skippedExistingCount,
    productCount,
  } = useLoaderData();

  const navigation = useNavigation();

  const isCreating = navigation.state === "submitting";

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

            const isActive = index === 4;

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

        <s-section>
          <strong>Final Confirmation</strong>

          <s-paragraph>
            Review the final vehicle and product combinations before starting
            page creation.
          </s-paragraph>
        </s-section>

        <div
          style={{
            display: "grid",

            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",

            gap: "12px",
          }}
        >
          <div style={summaryCardStyle}>
            <div
              style={{
                color: "#616161",

                fontSize: "13px",

                marginBottom: "5px",
              }}
            >
              Selected Vehicles
            </div>

            <div
              style={{
                fontSize: "28px",

                fontWeight: "700",
              }}
            >
              {selectedCount}
            </div>
          </div>

          <div style={summaryCardStyle}>
            <div
              style={{
                color: "#616161",

                fontSize: "13px",

                marginBottom: "5px",
              }}
            >
              Selected Products
            </div>

            <div
              style={{
                fontSize: "28px",

                fontWeight: "700",
              }}
            >
              {productCount}
            </div>
          </div>

          <div style={summaryCardStyle}>
            <div
              style={{
                color: "#616161",

                fontSize: "13px",

                marginBottom: "5px",
              }}
            >
              New Pages to Create
            </div>

            <div
              style={{
                fontSize: "28px",

                fontWeight: "700",
              }}
            >
              {pageCount}
            </div>
          </div>

          <div style={summaryCardStyle}>
            <div
              style={{
                color: "#616161",

                fontSize: "13px",

                marginBottom: "5px",
              }}
            >
              Existing Pages Skipped
            </div>

            <div
              style={{
                fontSize: "28px",

                fontWeight: "700",
              }}
            >
              {skippedExistingCount}
            </div>
          </div>

          <div style={summaryCardStyle}>
            <div
              style={{
                color: "#616161",

                fontSize: "13px",

                marginBottom: "5px",
              }}
            >
              Source File
            </div>

            <div
              style={{
                marginTop: "7px",

                fontWeight: "650",

                wordBreak: "break-word",
              }}
            >
              {upload.fileName}
            </div>
          </div>
        </div>

        <s-section>
          <strong>Products</strong>

          <div
            style={{
              marginTop: "10px",

              display: "flex",

              flexWrap: "wrap",

              gap: "8px",
            }}
          >
            {upload.sourceProducts?.length > 0 ? (
              upload.sourceProducts.map((product) => (
                <span
                  key={product.id}

                  style={{
                    padding: "7px 10px",

                    border: "1px solid #d8d8d8",

                    borderRadius: "999px",

                    background: "#f6f6f7",

                    fontSize: "12px",

                    fontWeight: "600",
                  }}
                >
                  {product.handle}
                </span>
              ))
            ) : (
              <span>No product suffix</span>
            )}
          </div>
        </s-section>

        <div
          style={{
            border: "1px solid #e6cf8b",

            background: "#fff8e6",

            borderRadius: "12px",

            padding: "16px",
          }}
        >
          <strong>Ready to create</strong>

          <div
            style={{
              marginTop: "6px",

              color: "#616161",

              lineHeight: "1.5",

              fontSize: "14px",
            }}
          >
            Each selected vehicle is combined with every selected product.
            Existing handles are checked again and skipped instead of
            overwritten.
          </div>
        </div>

        <div
          style={{
            display: "flex",

            justifyContent: "space-between",

            alignItems: "center",

            gap: "12px",
          }}
        >
          <Link to={`/app/review?uploadId=${encodeURIComponent(upload.id)}`}>
            ← Back to Review
          </Link>

          <Form method="post">
            <input
              type="hidden"

              name="uploadId"

              value={upload.id}
            />

            <button
              type="submit"

              disabled={isCreating || selectedCount === 0 || pageCount === 0}

              style={{
                padding: "9px 14px",

                borderRadius: "8px",

                border: "1px solid #c9c9c9",

                background: "#ffffff",

                fontWeight: "650",

                cursor: "pointer",
              }}
            >
              {isCreating
                ? "Starting Creation Job..."
                : `Create ${pageCount} Page${pageCount === 1 ? "" : "s"}`}
            </button>
          </Form>
        </div>
      </div>
    </s-page>
  );
}
