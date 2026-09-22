import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import { ArrowDownIcon } from "@shopify/polaris-icons";

import { authenticate } from "../shopify.server";

async function getFeedPages(admin) {
  const pages = [];

  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await admin.graphql(
      `#graphql
        query FeedPages($after: String) {
          pages(first: 100, after: $after) {
            nodes {
              id
              title
              handle
              isPublished
              templateSuffix
            }

            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `,
      {
        variables: {
          after: cursor,
        },
      },
    );

    const json = await response.json();

    if (json.errors?.length) {
      throw new Error(json.errors.map((error) => error.message).join(", "));
    }

    const connection = json.data?.pages;

    if (!connection) {
      break;
    }

    for (const page of connection.nodes) {
      if (page.templateSuffix === "product-ymmt") {
        pages.push(page);
      }
    }

    hasNextPage = connection.pageInfo.hasNextPage;

    cursor = connection.pageInfo.endCursor;
  }

  return pages;
}

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);

  const pages = await getFeedPages(admin);

  const publishedCount = pages.filter((page) => page.isPublished).length;

  return {
    shop: session.shop,
    totalPages: pages.length,
    publishedCount,
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  const url = new URL(request.url);

  /*
   * During local development this will use
   * the Shopify CLI tunnel origin.
   *
   * After production deployment it will
   * automatically become your hosted app URL.
   */
  const feedUrl = `${url.origin}/google-feed.xml?shop=${encodeURIComponent(
    session.shop,
  )}`;

  return {
    success: true,
    feedUrl,
  };
};

export default function GoogleFeed() {
  const { shop, totalPages, publishedCount } = useLoaderData();

  const actionData = useActionData();

  const navigation = useNavigation();

  const generating = navigation.state === "submitting";

  return (
    <s-page heading="Google Feed">
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "20px",
        }}
      >
        <s-section>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              marginBottom: "8px",
            }}
          >
            <s-icon type="product" />

            <strong>Google Merchant XML Feed</strong>
          </div>

          <s-paragraph>
            Generate an XML feed from the published YMMT pages in this Shopify
            store.
          </s-paragraph>
        </s-section>

        {/* Stats */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: "12px",
          }}
        >
          <div
            style={{
              background: "#ffffff",
              border: "1px solid #e3e3e3",
              borderRadius: "12px",
              padding: "16px",
            }}
          >
            <div
              style={{
                color: "#616161",
                fontSize: "13px",
              }}
            >
              YMMT Pages
            </div>

            <div
              style={{
                fontSize: "26px",
                fontWeight: "700",
                marginTop: "4px",
              }}
            >
              {totalPages}
            </div>
          </div>

          <div
            style={{
              background: "#ffffff",
              border: "1px solid #e3e3e3",
              borderRadius: "12px",
              padding: "16px",
            }}
          >
            <div
              style={{
                color: "#616161",
                fontSize: "13px",
              }}
            >
              Published
            </div>

            <div
              style={{
                fontSize: "26px",
                fontWeight: "700",
                marginTop: "4px",
              }}
            >
              {publishedCount}
            </div>
          </div>

          <div
            style={{
              background: "#ffffff",
              border: "1px solid #e3e3e3",
              borderRadius: "12px",
              padding: "16px",
            }}
          >
            <div
              style={{
                color: "#616161",
                fontSize: "13px",
              }}
            >
              Store
            </div>

            <div
              style={{
                marginTop: "6px",
                fontWeight: "650",
                wordBreak: "break-word",
              }}
            >
              {shop}
            </div>
          </div>
        </div>

        {/* Generate */}
        <s-section>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              gap: "12px",
            }}
          >
            <strong>Generate XML Feed</strong>

            <div
              style={{
                color: "#616161",
                fontSize: "13px",
                lineHeight: "1.5",
              }}
            >
              Only published YMMT pages will be included in the generated feed.
            </div>

            <Form method="post">
              <button
                type="submit"
                disabled={generating || publishedCount === 0}
                style={{
                  padding: "10px 16px",
                  borderRadius: "8px",
                  border: "none",
                  background:
                    generating || publishedCount === 0 ? "#b5b5b5" : "#303030",
                  color: "#ffffff",
                  fontWeight: "650",
                  cursor:
                    generating || publishedCount === 0
                      ? "not-allowed"
                      : "pointer",
                }}
              >
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "7px",
                    fill: "#ffffff",
                  }}
                >
                  <ArrowDownIcon width={18} height={18} />

                  {generating ? "Generating..." : "Generate XML Feed"}
                </span>
              </button>
            </Form>
          </div>
        </s-section>

        {/* Generated result */}
        {actionData?.success && (
          <s-section>
            <div
              style={{
                padding: "16px",
                background: "#f1fff2",
                border: "1px solid #b7ddb9",
                borderRadius: "10px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "7px",
                  fontWeight: "650",
                  color: "#176b35",
                }}
              >
                <s-icon type="check-circle" />
                XML feed generated successfully
              </div>

              <div
                style={{
                  marginTop: "8px",
                  color: "#616161",
                  fontSize: "13px",
                }}
              >
                {publishedCount} published YMMT pages will be included.
              </div>

              <div
                style={{
                  marginTop: "14px",
                }}
              >
                <a
                  href={actionData.feedUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    display: "inline-block",
                    padding: "10px 16px",
                    background: "#303030",
                    color: "#ffffff",
                    borderRadius: "8px",
                    textDecoration: "none",
                    fontWeight: "650",
                  }}
                >
                  Download XML Feed
                </a>
              </div>

              <div
                style={{
                  marginTop: "12px",
                  padding: "10px",
                  background: "#ffffff",
                  borderRadius: "8px",
                  border: "1px solid #e3e3e3",
                  wordBreak: "break-all",
                  fontSize: "12px",
                }}
              >
                <code>{actionData.feedUrl}</code>
              </div>
            </div>
          </s-section>
        )}
      </div>
    </s-page>
  );
}
