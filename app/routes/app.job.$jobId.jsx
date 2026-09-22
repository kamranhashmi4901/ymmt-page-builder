import { useEffect } from "react";
import {
  Form,
  Link,
  useLoaderData,
  useNavigation,
  useRevalidator,
} from "react-router";

import { authenticate } from "../shopify.server";

import {
  cancelYMMTJob,
  getYMMTJob,
  pauseYMMTJob,
  resumeYMMTJob,
} from "../lib/ymmt-jobs.server";

export const loader = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);

  const job = await getYMMTJob({
    jobId: params.jobId,
    shop: session.shop,
  });

  if (!job) {
    throw new Response("Job not found.", {
      status: 404,
    });
  }

  return { job };
};

export const action = async ({ request, params }) => {
  const { session, admin } = await authenticate.admin(request);

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "pause") {
    await pauseYMMTJob({
      jobId: params.jobId,
      shop: session.shop,
    });
  }

  if (intent === "resume") {
    await resumeYMMTJob({
      jobId: params.jobId,
      shop: session.shop,
      admin,
    });
  }

  if (intent === "cancel") {
    await cancelYMMTJob({
      jobId: params.jobId,
      shop: session.shop,
    });
  }

  return { success: true };
};

const statCardStyle = {
  background: "#ffffff",
  border: "1px solid #e3e3e3",
  borderRadius: "12px",
  padding: "16px",
};

function getStatusStyle(status) {
  if (status === "completed") {
    return {
      background: "#eaf7ee",
      color: "#176b35",
    };
  }

  if (status === "failed") {
    return {
      background: "#fbeae5",
      color: "#8a2e1b",
    };
  }

  if (status === "cancelled") {
    return {
      background: "#f1f1f1",
      color: "#616161",
    };
  }

  if (status === "paused") {
    return {
      background: "#fff4d6",
      color: "#7a5600",
    };
  }

  return {
    background: "#e8f1ff",
    color: "#1d4f91",
  };
}

export default function JobProgress() {
  const { job } = useLoaderData();

  const navigation = useNavigation();
  const revalidator = useRevalidator();

  const busy = navigation.state === "submitting";

  useEffect(() => {
    const timer = setInterval(() => {
      revalidator.revalidate();
    }, 1500);

    return () => clearInterval(timer);
  }, [revalidator]);

  const progress =
    job.total > 0 ? Math.round((job.processed / job.total) * 100) : 0;

  const statusStyle = getStatusStyle(job.status);

  const isFinished = ["completed", "failed", "cancelled"].includes(job.status);

  return (
    <s-page heading="YMMT Creation Job">
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "24px",
        }}
      >
        {/* Status heading */}
        <s-section>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "7px",
            }}
          >
            <s-icon type="chart-vertical" />
            <strong>Creation Progress</strong>
          </span>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "12px",
              flexWrap: "wrap",
            }}
          >
            <div>
              <s-paragraph>
                Monitor the current YMMT page creation job and review its
                detailed activity logs.
              </s-paragraph>
            </div>

            <span
              style={{
                display: "inline-block",
                padding: "6px 11px",
                borderRadius: "999px",
                fontSize: "12px",
                fontWeight: "700",
                textTransform: "capitalize",
                ...statusStyle,
              }}
            >
              {job.status}
            </span>
          </div>
        </s-section>

        {/* Progress bar */}
        <div
          style={{
            background: "#ffffff",
            border: "1px solid #e3e3e3",
            borderRadius: "12px",
            padding: "18px",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: "12px",
              marginBottom: "10px",
              flexWrap: "wrap",
            }}
          >
            <strong>Overall Progress</strong>

            <span
              style={{
                color: "#616161",
              }}
            >
              {job.processed} / {job.total}
              {" · "}
              {progress}%
            </span>
          </div>

          <div
            style={{
              width: "100%",
              height: "12px",
              background: "#e5e5e5",
              borderRadius: "999px",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${progress}%`,
                height: "100%",
                background:
                  job.status === "failed"
                    ? "#d72c0d"
                    : job.status === "completed"
                      ? "#008060"
                      : "#303030",
                transition: "width 0.3s ease",
              }}
            />
          </div>
        </div>

        {/* Job stats */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
            gap: "12px",
          }}
        >
          <div style={statCardStyle}>
            <div
              style={{
                fontSize: "13px",
                color: "#616161",
              }}
            >
              Total
            </div>

            <div
              style={{
                fontSize: "26px",
                fontWeight: "700",
                marginTop: "4px",
              }}
            >
              {job.total}
            </div>
          </div>

          <div style={statCardStyle}>
            <div
              style={{
                fontSize: "13px",
                color: "#616161",
              }}
            >
              Processed
            </div>

            <div
              style={{
                fontSize: "26px",
                fontWeight: "700",
                marginTop: "4px",
              }}
            >
              {job.processed}
            </div>
          </div>

          <div style={statCardStyle}>
            <div
              style={{
                fontSize: "13px",
                color: "#616161",
              }}
            >
              Created
            </div>

            <div
              style={{
                fontSize: "26px",
                fontWeight: "700",
                marginTop: "4px",
                color: "#176b35",
              }}
            >
              {job.created}
            </div>
          </div>

          <div style={statCardStyle}>
            <div
              style={{
                fontSize: "13px",
                color: "#616161",
              }}
            >
              Skipped
            </div>

            <div
              style={{
                fontSize: "26px",
                fontWeight: "700",
                marginTop: "4px",
                color: "#7a5600",
              }}
            >
              {job.skipped}
            </div>
          </div>

          <div style={statCardStyle}>
            <div
              style={{
                fontSize: "13px",
                color: "#616161",
              }}
            >
              Failed
            </div>

            <div
              style={{
                fontSize: "26px",
                fontWeight: "700",
                marginTop: "4px",
                color: job.failed > 0 ? "#8a2e1b" : "#303030",
              }}
            >
              {job.failed}
            </div>
          </div>
        </div>

        {/* Controls */}
        {!isFinished && (
          <s-section>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "7px",
              }}
            >
              <s-icon type="settings" />
              <strong>Job Controls</strong>
            </span>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "10px",
              }}
            >
              {job.status === "running" && (
                <Form method="post">
                  <s-button
                    icon="pause-circle"
                    type="submit"
                    name="intent"
                    value="pause"
                    disabled={busy}
                    style={{
                      padding: "9px 14px",
                      borderRadius: "8px",
                      border: "1px solid #c9c9c9",
                      background: "#ffffff",
                      fontWeight: "600",
                      cursor: "pointer",
                    }}
                  >
                    Pause Job
                  </s-button>
                </Form>
              )}

              {job.status === "paused" && (
                <Form method="post">
                  <s-button
                    icon="play-circle"
                    type="submit"
                    name="intent"
                    value="resume"
                    disabled={busy}
                    style={{
                      padding: "9px 14px",
                      borderRadius: "8px",
                      border: "none",
                      background: "#303030",
                      color: "#ffffff",
                      fontWeight: "650",
                      cursor: "pointer",
                    }}
                  >
                    Resume Job
                  </s-button>
                </Form>
              )}

              {["pending", "running", "paused"].includes(job.status) && (
                <Form method="post">
                  <s-button
                    icon="x-circle"
                    type="submit"
                    name="intent"
                    value="cancel"
                    disabled={busy}
                    style={{
                      padding: "9px 14px",
                      borderRadius: "8px",
                      border: "1px solid #d4a09a",
                      background: "#fff7f5",
                      color: "#8a2e1b",
                      fontWeight: "600",
                      cursor: "pointer",
                    }}
                  >
                    Cancel Job
                  </s-button>
                </Form>
              )}
            </div>
          </s-section>
        )}

        {/* Logs */}
        <s-section>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <s-icon type="clock" />
            <strong>Activity Logs</strong>
          </div>
          <div
            style={{
              background: "#151515",
              color: "#f2f2f2",
              borderRadius: "10px",
              border: "1px solid #2c2c2c",
              maxHeight: "480px",
              overflowY: "auto",
              fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
              fontSize: "12px",
            }}
          >
            {job.logs.length === 0 ? (
              <div
                style={{
                  padding: "18px",
                  color: "#bcbcbc",
                }}
              >
                No logs yet.
              </div>
            ) : (
              job.logs.map((log) => {
                const level = log.level.toUpperCase();

                let levelColor = "#d8d8d8";

                if (log.level === "success") {
                  levelColor = "#6fdc8c";
                }

                if (log.level === "error") {
                  levelColor = "#ff8a7a";
                }

                if (log.level === "warning" || log.level === "skipped") {
                  levelColor = "#f2c94c";
                }

                return (
                  <div
                    key={log.id}
                    style={{
                      padding: "9px 12px",
                      borderBottom: "1px solid #2b2b2b",
                      lineHeight: "1.5",
                    }}
                  >
                    <span
                      style={{
                        color: "#969696",
                      }}
                    >
                      [{new Date(log.createdAt).toLocaleTimeString()}]
                    </span>{" "}
                    <strong
                      style={{
                        color: levelColor,
                      }}
                    >
                      [{level}]
                    </strong>{" "}
                    {log.handle && (
                      <>
                        <code
                          style={{
                            color: "#9ecbff",
                          }}
                        >
                          {log.handle}
                        </code>{" "}
                      </>
                    )}
                    <span>{log.message}</span>
                  </div>
                );
              })
            )}
          </div>
        </s-section>

        {/* Finished state */}
        {job.status === "completed" && (
          <div
            style={{
              padding: "16px",
              background: "#f1fff2",
              border: "1px solid #b7ddb9",
              borderRadius: "12px",
            }}
          >
            <strong>Creation completed successfully.</strong>

            <div
              style={{
                marginTop: "5px",
                color: "#616161",
              }}
            >
              {job.created} pages created, {job.skipped} skipped and{" "}
              {job.failed} failed.
            </div>
          </div>
        )}

        {job.status === "failed" && (
          <div
            style={{
              padding: "16px",
              background: "#fff4f4",
              border: "1px solid #f1b8b8",
              borderRadius: "12px",
            }}
          >
            <strong>The creation job failed.</strong>

            <div
              style={{
                marginTop: "5px",
                color: "#616161",
              }}
            >
              Review the activity logs above for the exact error.
            </div>
          </div>
        )}

        {/* Bottom navigation */}
        {isFinished && (
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: "12px",
              flexWrap: "wrap",
            }}
          >
            <Link
              to="/app"
              style={{
                color: "#616161",
                textDecoration: "none",
                fontWeight: "600",
              }}
            >
              ← Back to Dashboard
            </Link>

            <Link
              to="/app/upload"
              style={{
                display: "inline-block",
                background: "#303030",
                color: "#ffffff",
                textDecoration: "none",
                padding: "10px 16px",
                borderRadius: "8px",
                fontWeight: "650",
              }}
            >
              Create Another Batch
            </Link>
          </div>
        )}
      </div>
    </s-page>
  );
}
