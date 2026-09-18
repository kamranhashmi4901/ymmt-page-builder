import { useRef, useState } from "react";
import { Link, useActionData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";

import { parseYMMT } from "../lib/ymmt-parser.server";
import { saveYMMTUpload } from "../lib/ymmt-uploads.server";

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

export default function Upload() {
  const actionData = useActionData();
  const navigation = useNavigation();
  const fileInputRef = useRef(null);
  const [fileName, setFileName] = useState("");

  const isUploading = navigation.state === "submitting";

  return (
    <s-page heading="Upload YMMT Data">
      <s-section heading="YMMT JSON File">
        <s-paragraph>
          Upload your Year, Make, Model and Trim compatibility data.
        </s-paragraph>

        <form method="post" encType="multipart/form-data">
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "16px",
              marginTop: "16px",
              maxWidth: "500px",
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

            <s-button
              type="button"
              onClick={() => fileInputRef.current?.click()}
            >
              Choose JSON File
            </s-button>

            {fileName && (
              <s-paragraph>
                Selected: <strong>{fileName}</strong>
              </s-paragraph>
            )}

            <div>
              <button type="submit" disabled={!fileName || isUploading}>
                {isUploading ? "Processing..." : "Upload and Parse"}
              </button>
            </div>
          </div>
        </form>
      </s-section>

      {actionData?.error && (
        <s-section heading="Upload Error">
          <s-paragraph>{actionData.error}</s-paragraph>
        </s-section>
      )}

      {actionData?.success && (
        <s-section heading="File Summary">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              File: <strong>{actionData.fileName}</strong>
            </s-paragraph>

            <s-paragraph>
              Records: <strong>{actionData.stats.totalEntries}</strong>
            </s-paragraph>

            <s-paragraph>
              Years: <strong>{actionData.stats.totalYears}</strong>
            </s-paragraph>

            <s-paragraph>
              Makes: <strong>{actionData.stats.totalMakes}</strong>
            </s-paragraph>

            <s-paragraph>
              Models: <strong>{actionData.stats.totalModels}</strong>
            </s-paragraph>

            <s-paragraph>
              Trims: <strong>{actionData.stats.totalTrims}</strong>
            </s-paragraph>

            <s-paragraph>
              With trim: <strong>{actionData.stats.withTrim}</strong>
            </s-paragraph>

            <s-paragraph>
              Without trim: <strong>{actionData.stats.withoutTrim}</strong>
            </s-paragraph>

            <s-paragraph>
              EKR: <strong>{actionData.stats.manufacturers.EKR}</strong>
              {" | "}
              SCS: <strong>{actionData.stats.manufacturers.SCS}</strong>
              {" | "}
              Other: <strong>{actionData.stats.manufacturers.Other}</strong>
            </s-paragraph>

            <div style={{ marginTop: "16px" }}>
              <Link
                to={`/app/product?uploadId=${encodeURIComponent(actionData.uploadId)}`}
              >
                Continue to Product Selection
              </Link>
            </div>
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}
