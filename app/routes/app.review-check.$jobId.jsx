import { authenticate } from "../shopify.server";
import { getReviewCheck, advanceReviewCheck } from "../lib/review-check-jobs.server";

export const loader = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);
  return { check: await getReviewCheck(session.shop, params.jobId) };
};
export const action = async ({ request, params }) => {
  const { session, admin } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  if (!["advance", "retry"].includes(intent)) return { error: "Unsupported review check action." };
  try { return { check: await advanceReviewCheck(session.shop, params.jobId, admin, intent === "retry"), reviewCheckAction: true }; }
  catch (error) { if (error instanceof Response) throw error; return { error: error.message || "Unable to check this batch. Retry shortly.", reviewCheckAction: true }; }
};
