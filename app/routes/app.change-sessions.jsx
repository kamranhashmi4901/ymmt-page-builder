import { Link, useLoaderData, useRouteError } from "react-router";
import { authenticate } from "../shopify.server";
import { getRecentActionSessions } from "../lib/page-change-log.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const offset = Math.max(0, Math.floor(Number(new URL(request.url).searchParams.get("offset")) || 0));
  return { sessions: await getRecentActionSessions(session.shop, 50, { offset }), offset };
};
const cell = { padding: "12px", borderBottom: "1px solid #ddd", textAlign: "left" };
export default function ChangeSessions() {
  const { sessions, offset } = useLoaderData();
  return <s-page heading="Recent Change Sessions">
    <s-section>
      {!sessions.length ? <p>No change sessions recorded on this page.</p> : <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>{["Date", "Action", "Pages", "Success", "Failed", "Remaining", "Status", "Details"].map((label) => <th key={label} style={cell}>{label}</th>)}</tr></thead>
          <tbody>{sessions.map((session) => <tr key={session.id}>
            <td style={cell}>{new Date(session.createdAt).toLocaleString()}</td>
            <td style={cell}>{session.actionType}</td>
            <td style={cell}>{session.totalPages}</td>
            <td style={cell}>{session.successCount}</td>
            <td style={cell}>{session.failedCount}</td>
            <td style={cell}>{session.remaining}</td>
            <td style={cell}>{session.status.replaceAll("_", " ")}{session.rolledBackAt ? " (rolled back)" : ""}</td>
            <td style={cell}><Link to={session.actionType === "update-content" ? `/app/page-update/${session.id}` : `/app/manage?sessionId=${session.id}`}>View Changes</Link></td>
          </tr>)}</tbody>
        </table>
      </div>}
      <p>{offset > 0 && <Link to={`/app/change-sessions?offset=${Math.max(0, offset - 50)}`}>Previous 50 · </Link>}{sessions.length === 50 && <Link to={`/app/change-sessions?offset=${offset + 50}`}>Next 50</Link>}</p>
    </s-section>
  </s-page>;
}
export function ErrorBoundary() {
  useRouteError();
  return <s-page heading="Recent Change Sessions"><p role="alert">Unable to load change sessions. Check the app server logs.</p><Link to="/app/manage">Back to Manage Pages</Link></s-page>;
}
