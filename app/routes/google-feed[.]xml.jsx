import { unauthenticated } from "../shopify.server";

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function parseVehicle(value) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
}

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

              vehicle: metafield(
                namespace: "ymmt"
                key: "vehicle"
              ) {
                value
              }

              productHandle: metafield(
                namespace: "ymmt"
                key: "product_handle"
              ) {
                value
              }
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
      if (page.templateSuffix !== "product-ymmt" || !page.isPublished) {
        continue;
      }

      pages.push({
        id: page.id,
        title: page.title,
        handle: page.handle,

        vehicle: parseVehicle(page.vehicle?.value),

        productHandle: page.productHandle?.value || "",
      });
    }

    hasNextPage = connection.pageInfo.hasNextPage;

    cursor = connection.pageInfo.endCursor;
  }

  return pages;
}

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  const shop = url.searchParams.get("shop");

  if (!shop) {
    return new Response("Shop parameter is required.", {
      status: 400,
    });
  }

  try {
    const { admin } = await unauthenticated.admin(shop);

    const pages = await getFeedPages(admin);

    const storefrontUrl = `https://${shop}`;

    const items = pages
      .map((page) => {
        const vehicle = page.vehicle || {};

        const vehicleName = [
          vehicle.year,
          vehicle.make,
          vehicle.model,
          vehicle.trim,
        ]
          .filter(Boolean)
          .join(" ");

        const description = [
          page.title,

          vehicleName ? `Vehicle: ${vehicleName}.` : "",

          vehicle.compatible || vehicle.compat
            ? `Compatibility: ${vehicle.compatible || vehicle.compat}.`
            : "",
        ]
          .filter(Boolean)
          .join(" ");

        const pageUrl = `${storefrontUrl}/pages/${page.handle}`;

        return `
    <item>
      <g:id>${escapeXml(page.handle)}</g:id>

      <title>${escapeXml(page.title)}</title>

      <description>${escapeXml(description)}</description>

      <link>${escapeXml(pageUrl)}</link>

      <g:availability>
        in_stock
      </g:availability>

      <g:condition>
        new
      </g:condition>

      <g:custom_label_0>${escapeXml(vehicle.year || "")}</g:custom_label_0>

      <g:custom_label_1>${escapeXml(vehicle.make || "")}</g:custom_label_1>

      <g:custom_label_2>${escapeXml(vehicle.model || "")}</g:custom_label_2>

      <g:custom_label_3>${escapeXml(vehicle.trim || "")}</g:custom_label_3>

      <g:custom_label_4>${escapeXml(
        page.productHandle || "",
      )}</g:custom_label_4>
    </item>`;
      })
      .join("\n");

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss
  version="2.0"
  xmlns:g="http://base.google.com/ns/1.0"
>
  <channel>

    <title>
      YMMT Google Merchant Feed
    </title>

    <link>
      ${escapeXml(storefrontUrl)}
    </link>

    <description>
      Published YMMT Pages
    </description>

    <lastBuildDate>
      ${escapeXml(new Date().toUTCString())}
    </lastBuildDate>

${items}

  </channel>
</rss>`;

    return new Response(xml, {
      status: 200,

      headers: {
        "Content-Type": "application/xml; charset=utf-8",

        "Content-Disposition": 'attachment; filename="ymmt-google-feed.xml"',

        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("Google feed generation error:", error);

    return new Response(
      `Unable to generate XML feed: ${error.message || "Unknown error"}`,
      {
        status: 500,
      },
    );
  }
};
