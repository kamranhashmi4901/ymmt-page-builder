import { Link, useLoaderData, useRouteError } from "react-router";
import { authenticate } from "../shopify.server";
import { getRecentActionSessions } from "../lib/page-change-log.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const offset = Math.max(
    0,
    Math.floor(Number(new URL(request.url).searchParams.get("offset")) || 0),
  );
  return {
    jobs: await getRecentActionSessions(session.shop, 50, {
      actionType: "update-content",
      offset,
    }),
    offset,
  };
};
const cell = {
  padding: "12px",
  borderBottom: "1px solid #ddd",
  textAlign: "left",
};
export default function PageUpdates() {
  const { jobs, offset } = useLoaderData();
  return (
    <s-page heading="Page Update Jobs">
      <p>
        <Link to="/app/manage">← Manage Pages and saved searches</Link>
      </p>
      <s-section>
        <p>
          Open a job to see saved results, resume its queue, or download
          verified updates. Failed and incomplete jobs require attention.
        </p>
        {!jobs.length ? (
          <p>No update jobs on this page.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  {[
                    "Created",
                    "Pages",
                    "Updated",
                    "Already correct",
                    "Failed",
                    "Remaining",
                    "Status",
                    "Job",
                  ].map((name) => (
                    <th key={name} style={cell}>
                      {name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id}>
                    <td style={cell}>
                      {new Date(job.createdAt).toLocaleString()}
                    </td>
                    <td style={cell}>{job.totalPages}</td>
                    <td style={cell}>{job.updated}</td>
                    <td style={cell}>{job.unchanged}</td>
                    <td style={cell}>{job.failed}</td>
                    <td style={cell}>{job.remaining}</td>
                    <td style={cell}>{job.status.replaceAll("_", " ")}</td>
                    <td style={cell}>
                      <Link to={`/app/page-update/${job.id}`}>Open job</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p>
          {offset > 0 && (
            <Link to={`/app/page-updates?offset=${Math.max(0, offset - 50)}`}>
              Previous 50 ·{" "}
            </Link>
          )}
          {jobs.length === 50 && (
            <Link to={`/app/page-updates?offset=${offset + 50}`}>Next 50</Link>
          )}
        </p>
      </s-section>
    </s-page>
  );
}
export function ErrorBoundary() {
  const error = useRouteError();
  return (
    <s-page heading="Page Update Jobs">
      <p role="alert">
        {error?.status === 404
          ? "Jobs were not found for this store."
          : "Unable to load job history. Check the app server logs."}
      </p>
      <Link to="/app/manage">Back to Manage Pages</Link>
    </s-page>
  );
}
