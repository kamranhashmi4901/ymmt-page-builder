import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export default function Index() {
  return (
    <s-page heading="YMMT Page Manager">
      <s-section heading="Welcome">
        <s-paragraph>
          Manage YMMT vehicle data and Shopify fitment pages from here.
        </s-paragraph>
      </s-section>

      <s-section heading="Getting Started">
        <s-stack direction="block" gap="base">
          <s-button variant="primary">Upload YMMT Data</s-button>
          <s-button>Manage Pages</s-button>
        </s-stack>
      </s-section>
    </s-page>
  );
}
