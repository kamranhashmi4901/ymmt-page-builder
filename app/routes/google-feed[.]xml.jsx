import { downloadFeed } from "../lib/google-feed-jobs.server";

// Download completed files only. This request never calls Shopify or generates XML.
export const loader = async ({ request }) => {
  try {
    return await downloadFeed(request);
  } catch (error) {
    console.error("Google feed file download error:", error);
    return new Response(
      "Unable to open the saved export. Return to Google Feed and check its status.",
      {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
};
