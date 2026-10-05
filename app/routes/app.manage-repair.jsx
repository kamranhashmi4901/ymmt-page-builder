import { redirect } from "react-router";
import { authenticate } from "../shopify.server";
export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  // Old repair sessions are not scan-only sessions. Keep embedded app context,
  // but do not pass their IDs to the new scanner.
  url.pathname = "/app/scan-pages";
  url.searchParams.delete("job"); url.searchParams.delete("offset");
  return redirect(url.pathname + url.search);
};
export const action = async ({ request }) => {
  await authenticate.admin(request);
  return new Response("Page correction actions were removed. Open Scan Pages.", { status: 410 });
};
