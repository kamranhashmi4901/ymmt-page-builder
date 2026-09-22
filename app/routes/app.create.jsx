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

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);

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

  const selectedCount = await db.ymmtRecord.count({
    where: {
      uploadId,
      selected: true,
      duplicate: false,
    },
  });

  return {
    upload,
    selectedCount,
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

const summaryCardStyle = {
  background: "#ffffff",
  border: "1px solid #e3e3e3",
  borderRadius: "12px",
  padding: "16px",
};

export default function CreatePages() {
  const { upload, selectedCount } = useLoaderData();
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

            const isActive = index === 4;
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

        <s-section>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "7px",
            }}
          >
            <s-icon type="check-circle" />
            <strong>Final Confirmation</strong>
          </span>
          <s-paragraph>
            Review the final selection before starting page creation. Once
            started, the job will continue in the background and you can monitor
            progress, logs, skipped pages and failures from the Job Progress
            screen.
          </s-paragraph>
        </s-section>

        {/* Summary cards */}
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
              }}
            >
              Selected Pages
            </div>

            <div
              style={{
                fontSize: "28px",
                fontWeight: "700",
                marginTop: "5px",
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

          <div style={summaryCardStyle}>
            <div
              style={{
                color: "#616161",
                fontSize: "13px",
              }}
            >
              Product Handle
            </div>

            <div
              style={{
                marginTop: "7px",
                fontWeight: "650",
                wordBreak: "break-word",
              }}
            >
              {upload.sourceProductHandle || "No product suffix"}
            </div>
          </div>
        </div>

        {/* Safety notice */}
        <div
          style={{
            border: "1px solid #e6cf8b",
            background: "#fff8e6",
            borderRadius: "12px",
            padding: "16px",
          }}
        >
          <div
            style={{
              fontWeight: "650",
              marginBottom: "6px",
            }}
          >
            Ready to create
          </div>

          <div
            style={{
              color: "#616161",
              lineHeight: "1.5",
              fontSize: "14px",
            }}
          >
            Only the pages selected during Review will be processed. Existing
            page handles are checked again during creation and will be skipped
            if they already exist.
          </div>
        </div>

        {/* What happens next */}
        <s-section>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "7px",
            }}
          >
            <s-icon type="arrow-right" />
            <strong>What Happens Next</strong>
          </span>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
              gap: "14px",
            }}
          >
            <div>
              <strong>1. Job starts</strong>
              <div
                style={{
                  marginTop: "4px",
                  color: "#616161",
                  fontSize: "13px",
                  lineHeight: "1.5",
                }}
              >
                A background creation job is created for the selected records.
              </div>
            </div>

            <div>
              <strong>2. Shopify pages are created</strong>
              <div
                style={{
                  marginTop: "4px",
                  color: "#616161",
                  fontSize: "13px",
                  lineHeight: "1.5",
                }}
              >
                Page titles, handles, template assignment and YMMT metafields
                are written to Shopify.
              </div>
            </div>

            <div>
              <strong>3. Progress is tracked</strong>
              <div
                style={{
                  marginTop: "4px",
                  color: "#616161",
                  fontSize: "13px",
                  lineHeight: "1.5",
                }}
              >
                Created, skipped and failed pages are tracked with detailed
                logs.
              </div>
            </div>
          </div>
        </s-section>

        {/* Bottom actions */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "12px",
            flexWrap: "wrap",
          }}
        >
          <Link
            to={`/app/review?uploadId=${encodeURIComponent(upload.id)}`}
            style={{
              color: "#616161",
              textDecoration: "none",
              fontWeight: "600",
            }}
          >
            ← Back to Review
          </Link>

          <Form method="post">
            <input type="hidden" name="uploadId" value={upload.id} />

            <button
              type="submit"
              disabled={isCreating || selectedCount === 0}
              style={{
                padding: "12px 20px",
                borderRadius: "8px",
                border: "none",
                background:
                  isCreating || selectedCount === 0 ? "#b5b5b5" : "#303030",
                color: "#ffffff",
                fontWeight: "650",
                cursor:
                  isCreating || selectedCount === 0 ? "not-allowed" : "pointer",
              }}
            >
              {isCreating
                ? "Starting Creation Job..."
                : `Create ${selectedCount} Pages`}
            </button>
          </Form>
        </div>
      </div>
    </s-page>
  );
}
