import { useRef, useState } from "react";
import { Form, Link, useActionData, useNavigation } from "react-router";

import crypto from "crypto";

import { authenticate } from "../shopify.server";
import { parseYMMT } from "../lib/ymmt-parser.server";
import { findUploadByHash, saveYMMTUpload } from "../lib/ymmt-uploads.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  return null;
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  try {
    const formData = await request.formData();
    const file = formData.get("ymmtFile");

    if (!file || typeof file.text !== "function") {
      return {
        success: false,
        error: "Please select a JSON file.",
      };
    }

    if (
      file.type &&
      file.type !== "application/json" &&
      !file.name?.toLowerCase().endsWith(".json")
    ) {
      return {
        success: false,
        error: "Only JSON files are supported.",
      };
    }

    const fileText = await file.text();

    const fileHash = crypto.createHash("sha256").update(fileText).digest("hex");

    const existingUpload = await findUploadByHash({
      shop: session.shop,
      fileHash,
    });

    if (existingUpload) {
      return {
        success: false,
        duplicateUpload: true,
        error: `This file has already been uploaded as "${existingUpload.fileName}".`,
        existingUploadId: existingUpload.id,
      };
    }

    let raw;

    try {
      raw = JSON.parse(fileText);
    } catch {
      return {
        success: false,
        error: "The uploaded file contains invalid JSON.",
      };
    }

    const parsed = parseYMMT(raw);

    const upload = await saveYMMTUpload({
      shop: session.shop,
      fileName: file.name,
      fileHash,
      entries: parsed.entries,
      stats: parsed.stats,
    });

    return {
      success: true,
      uploadId: upload.id,
      fileName: file.name,
      stats: parsed.stats,
    };
  } catch (error) {
    console.error("YMMT upload error:", error);

    return {
      success: false,
      error: error.message || "Unable to process YMMT file.",
    };
  }
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

const statCardStyle = {
  background: "#ffffff",
  border: "1px solid #e3e3e3",
  borderRadius: "12px",
  padding: "18px",
};

export default function Upload() {
  const actionData = useActionData();
  const navigation = useNavigation();

  const fileInputRef = useRef(null);
  const [fileName, setFileName] = useState("");

  const isUploading = navigation.state === "submitting";

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

            const isActive = index === 0;
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
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <s-icon type="upload" />
            <strong>Upload YMMT Data</strong>
          </div>
          <s-paragraph>
            Upload your Year, Make, Model and Trim compatibility JSON file. The
            data will be parsed and stored before continuing to product
            selection.
          </s-paragraph>

          <Form method="post" encType="multipart/form-data">
            <div
              style={{
                marginTop: "20px",
                border: "1px dashed #b7b7b7",
                borderRadius: "14px",
                padding: "32px",
                background: "#fafafa",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                textAlign: "center",
                gap: "14px",
              }}
            >
              <input
                ref={fileInputRef}
                type="file"
                name="ymmtFile"
                accept=".json,application/json"
                required
                style={{ display: "none" }}
                onChange={(event) => {
                  setFileName(event.target.files?.[0]?.name || "");
                }}
              />

              <div
                style={{
                  fontSize: "17px",
                  fontWeight: "650",
                }}
              >
                Choose your YMMT JSON file
              </div>

              <div
                style={{
                  color: "#6d6d6d",
                  fontSize: "14px",
                }}
              >
                Supports Year → Make → Model and Year → Make → Model → Trim
                formats.
              </div>

              <s-button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                icon="file"
              >
                Choose JSON File
              </s-button>

              {fileName && (
                <div
                  style={{
                    padding: "10px 14px",
                    borderRadius: "8px",
                    background: "#ffffff",
                    border: "1px solid #e3e3e3",
                    fontSize: "14px",
                  }}
                >
                  Selected: <strong>{fileName}</strong>
                </div>
              )}

              <s-button
                type="submit"
                disabled={!fileName || isUploading}
                style={{
                  marginTop: "4px",
                  padding: "10px 18px",
                  borderRadius: "8px",
                  border: "none",
                  background: !fileName || isUploading ? "#b5b5b5" : "#303030",
                  color: "#ffffff",
                  fontWeight: "650",
                  cursor: !fileName || isUploading ? "not-allowed" : "pointer",
                }}
                icon="upload"
              >
                {isUploading ? "Processing..." : "Upload & Parse"}
              </s-button>
            </div>
          </Form>
        </s-section>

        {actionData?.error && (
          <div
            style={{
              border: "1px solid #f1b8b8",
              background: "#fff4f4",
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
              Upload Error
            </div>

            <div>{actionData.error}</div>

            {actionData.duplicateUpload && actionData.existingUploadId && (
              <div style={{ marginTop: "12px" }}>
                <Link
                  to={`/app/product?uploadId=${encodeURIComponent(
                    actionData.existingUploadId,
                  )}`}
                >
                  Continue with existing upload
                </Link>
              </div>
            )}
          </div>
        )}

        {actionData?.success && (
          <>
            <s-section>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "7px",
                }}
              >
                <s-icon type="file" />
                <strong>File Summary</strong>
              </span>
              <div
                style={{
                  marginBottom: "16px",
                  color: "#616161",
                }}
              >
                File: <strong>{actionData.fileName}</strong>
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                  gap: "12px",
                }}
              >
                <div style={statCardStyle}>
                  <div
                    style={{
                      fontSize: "24px",
                      fontWeight: "700",
                    }}
                  >
                    {actionData.stats.totalEntries}
                  </div>
                  <div style={{ color: "#616161" }}>Records</div>
                </div>

                <div style={statCardStyle}>
                  <div
                    style={{
                      fontSize: "24px",
                      fontWeight: "700",
                    }}
                  >
                    {actionData.stats.totalYears}
                  </div>
                  <div style={{ color: "#616161" }}>Years</div>
                </div>

                <div style={statCardStyle}>
                  <div
                    style={{
                      fontSize: "24px",
                      fontWeight: "700",
                    }}
                  >
                    {actionData.stats.totalMakes}
                  </div>
                  <div style={{ color: "#616161" }}>Makes</div>
                </div>

                <div style={statCardStyle}>
                  <div
                    style={{
                      fontSize: "24px",
                      fontWeight: "700",
                    }}
                  >
                    {actionData.stats.totalModels}
                  </div>
                  <div style={{ color: "#616161" }}>Models</div>
                </div>

                <div style={statCardStyle}>
                  <div
                    style={{
                      fontSize: "24px",
                      fontWeight: "700",
                    }}
                  >
                    {actionData.stats.totalTrims}
                  </div>
                  <div style={{ color: "#616161" }}>Trims</div>
                </div>
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                  gap: "12px",
                  marginTop: "16px",
                }}
              >
                <div style={statCardStyle}>
                  <strong>Trim Coverage</strong>

                  <div style={{ marginTop: "8px", color: "#616161" }}>
                    With trim: <strong>{actionData.stats.withTrim}</strong>
                  </div>

                  <div style={{ color: "#616161" }}>
                    Without trim:{" "}
                    <strong>{actionData.stats.withoutTrim}</strong>
                  </div>
                </div>

                <div style={statCardStyle}>
                  <strong>Manufacturers</strong>

                  <div style={{ marginTop: "8px", color: "#616161" }}>
                    EKR: <strong>{actionData.stats.manufacturers.EKR}</strong>
                  </div>

                  <div style={{ color: "#616161" }}>
                    SCS: <strong>{actionData.stats.manufacturers.SCS}</strong>
                  </div>

                  <div style={{ color: "#616161" }}>
                    Other:{" "}
                    <strong>{actionData.stats.manufacturers.Other}</strong>
                  </div>
                </div>
              </div>
            </s-section>

            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
              }}
            >
              <Link
                to={`/app/product?uploadId=${encodeURIComponent(
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
                Continue to Product Selection →
              </Link>
            </div>
          </>
        )}
      </div>
    </s-page>
  );
}
