import { Link } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

const cardStyle = {
  background: "#ffffff",
  border: "1px solid #e3e3e3",
  borderRadius: "14px",
  padding: "22px",
  minHeight: "190px",
  display: "flex",
  flexDirection: "column",
  justifyContent: "space-between",
};

const stepStyle = {
  background: "#ffffff",
  border: "1px solid #e3e3e3",
  borderRadius: "10px",
  padding: "14px 16px",
  minWidth: "130px",
  textAlign: "center",
};

export default function Index() {
  const workflow = [
    "Upload Data",
    "Select Product",
    "Filter & Preview",
    "Review & Select",
    "Create Pages",
    "Progress & Logs",
  ];

  return (
    <s-page heading="YMMT Page Builder">
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "24px",
        }}
      >
        <div>
          <s-heading>Vehicle Fitment Page Management</s-heading>

          <div style={{ marginTop: "8px", maxWidth: "720px" }}>
            <s-paragraph>
              Create and manage Shopify YMMT fitment pages using your Year,
              Make, Model and Trim compatibility data.
            </s-paragraph>
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
            gap: "18px",
          }}
        >
          <div style={cardStyle}>
            <div>
              <div
                style={{
                  fontSize: "18px",
                  fontWeight: "650",
                  marginBottom: "8px",
                }}
              >
                Create YMMT Pages
              </div>

              <div
                style={{
                  color: "#616161",
                  lineHeight: "1.5",
                }}
              >
                Upload vehicle compatibility data, choose a product, filter the
                records, review duplicates and create Shopify pages in bulk.
              </div>
            </div>

            <div style={{ marginTop: "22px" }}>
              <Link
                to="/app/upload"
                style={{
                  display: "inline-block",
                  background: "#303030",
                  color: "#ffffff",
                  textDecoration: "none",
                  padding: "10px 16px",
                  borderRadius: "8px",
                  fontWeight: "600",
                }}
              >
                Start Creating
              </Link>
            </div>
          </div>

          <div style={cardStyle}>
            <div>
              <div
                style={{
                  fontSize: "18px",
                  fontWeight: "650",
                  marginBottom: "8px",
                }}
              >
                Manage Existing Pages
              </div>

              <div
                style={{
                  color: "#616161",
                  lineHeight: "1.5",
                }}
              >
                Search existing YMMT pages and manage bulk updates or deletions
                from one place.
              </div>
            </div>

            <div style={{ marginTop: "22px" }}>
              <Link
                to="/app/manage"
                style={{
                  display: "inline-block",
                  background: "#ffffff",
                  color: "#303030",
                  textDecoration: "none",
                  padding: "10px 16px",
                  borderRadius: "8px",
                  border: "1px solid #c9c9c9",
                  fontWeight: "600",
                }}
              >
                Manage Pages
              </Link>
            </div>
          </div>
        </div>

        <s-section>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "7px",
            }}
          >
            <s-icon type="list-numbered" />
            <strong>Page Creation Workflow</strong>
          </span>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: "10px",
              marginTop: "10px",
            }}
          >
            {workflow.map((step, index) => (
              <div
                key={step.label}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "10px",
                }}
              >
                <div style={stepStyle}>
                  <div
                    style={{
                      fontSize: "12px",
                      color: "#777",
                      marginBottom: "4px",
                    }}
                  >
                    STEP {index + 1}
                  </div>

                  <div style={{ fontWeight: "600" }}>{step}</div>
                </div>

                {index < workflow.length - 1 && (
                  <div
                    style={{
                      color: "#888",
                      fontSize: "18px",
                    }}
                  >
                    →
                  </div>
                )}
              </div>
            ))}
          </div>
        </s-section>

        <s-section>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "7px",
            }}
          >
            <s-icon type="shield-check-mark" />
            <strong>Built-in Safety</strong>
          </span>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
              gap: "14px",
              marginTop: "8px",
            }}
          >
            <div>
              <strong>Persistent YMMT Data</strong>
              <div style={{ color: "#616161", marginTop: "4px" }}>
                Uploaded vehicle records are stored in the app database.
              </div>
            </div>

            <div>
              <strong>Duplicate Detection</strong>
              <div style={{ color: "#616161", marginTop: "4px" }}>
                Existing Shopify page handles are checked before creation.
              </div>
            </div>

            <div>
              <strong>Job Progress & Logs</strong>
              <div style={{ color: "#616161", marginTop: "4px" }}>
                Bulk jobs show progress, created, skipped and failed pages.
              </div>
            </div>

            <div>
              <strong>Pause / Resume / Cancel</strong>
              <div style={{ color: "#616161", marginTop: "4px" }}>
                Long-running creation jobs can be controlled from the app.
              </div>
            </div>
          </div>
        </s-section>
      </div>
    </s-page>
  );
}
