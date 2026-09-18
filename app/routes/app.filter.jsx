import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { getYMMTUpload } from "../lib/ymmt-uploads.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  const url = new URL(request.url);
  const uploadId = url.searchParams.get("uploadId");

  if (!uploadId) {
    throw new Response("Upload ID is required.", { status: 400 });
  }

  const upload = await getYMMTUpload({
    uploadId,
    shop: session.shop,
  });

  if (!upload) {
    throw new Response("YMMT upload not found.", { status: 404 });
  }

  return {
    upload: {
      id: upload.id,
      fileName: upload.fileName,
      totalRecords: upload.totalRecords,
      totalYears: upload.totalYears,
      totalMakes: upload.totalMakes,
      totalModels: upload.totalModels,
      totalTrims: upload.totalTrims,
      sourceProductHandle: upload.sourceProductHandle,
    },
  };
};

export default function FilterPreview() {
  const { upload } = useLoaderData();

  return (
    <s-page heading="Filter & Preview">
      <s-section heading="Current Upload">
        <s-paragraph>
          File: <strong>{upload.fileName}</strong>
        </s-paragraph>

        <s-paragraph>
          Records: <strong>{upload.totalRecords}</strong>
        </s-paragraph>

        <s-paragraph>
          Product:{" "}
          <strong>{upload.sourceProductHandle || "No product suffix"}</strong>
        </s-paragraph>
      </s-section>

      <s-section heading="Filters">
        <s-paragraph>
          Year, Make, Model, Trim and Manufacturer filters will be added here.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}
