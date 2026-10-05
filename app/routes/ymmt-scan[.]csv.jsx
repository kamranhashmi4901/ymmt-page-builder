import { downloadScanReport } from "../lib/ymmt-page-scan-jobs.server";
export const loader = async ({ request }) => {
  try { return await downloadScanReport(request, "csv"); }
  catch { return new Response("Unable to open the saved CSV. Return to Scan Pages and check the scan log.", { status: 503, headers: { "Cache-Control": "no-store" } }); }
};
