import { downloadScanReport } from "../lib/ymmt-page-scan-jobs.server";
export const loader = async ({ request }) => {
  try { return await downloadScanReport(request, "json"); }
  catch { return new Response("Unable to open the saved JSON. Return to Scan Pages and check the scan log.", { status: 503, headers: { "Cache-Control": "no-store" } }); }
};
