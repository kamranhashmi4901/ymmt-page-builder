import { downloadRepairCsv } from "../lib/ymmt-page-repair-jobs.server";
export const loader = async ({ request }) => {
  try { return await downloadRepairCsv(request); }
  catch { return new Response("Unable to open the saved report. Return to Manage Pages and check the repair session.", { status: 503, headers: { "Cache-Control": "no-store" } }); }
};
