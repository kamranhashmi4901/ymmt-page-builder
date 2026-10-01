// These text defaults and the item field order match the supplied reference XML.
const CATEGORY = "Vehicles & Parts > Vehicle Parts & Accessories > Motor Vehicle Parts > Motor Vehicle Carpet & Upholstery";
const BRAND = "Ever Seats";
const HIGHLIGHTS = "Premium Quality, Perfect Fit, Effortless to Maintain, Durable Material Resistant to Wear & Tear, Supportive Cushions";
const TITLE_SUFFIX = "Premium Nappa Leather, Accurate Fit, Easy to Install";

export const PAGE_QUERY = `#graphql
  query FeedPages($after: String, $query: String) {
    pages(first: 100, after: $after, query: $query) {
      nodes {
        id title handle isPublished templateSuffix
        vehicle: metafield(namespace: "ymmt", key: "vehicle") { value }
        productHandle: metafield(namespace: "ymmt", key: "product_handle") { value }
        sourceProductHandle: metafield(namespace: "ymmt", key: "source_product_handle") { value }
        seoTitle: metafield(namespace: "global", key: "title_tag") { value }
        seoDescription: metafield(namespace: "global", key: "description_tag") { value }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const PRODUCT_QUERY = `#graphql
  query FeedProduct($handle: String!, $after: String) {
    productByHandle(handle: $handle) {
      id handle title
      featuredMedia { ... on MediaImage { image { url } } }
      variants(first: 100, after: $after) {
        nodes {
          id legacyResourceId position price sku availableForSale
          selectedOptions { name value }
          media(first: 1) { nodes { ... on MediaImage { image { url } } } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

function parseVehicle(value) {
  try {
    const result = JSON.parse(value || "{}");
    return result && typeof result === "object" && !Array.isArray(result) ? result : {};
  } catch { return {}; }
}

function vehicleField(vehicle, name) {
  return String(vehicle[name] ?? vehicle[name[0].toUpperCase() + name.slice(1)] ?? "").trim();
}

export function pageYear(page) {
  const year = vehicleField(parseVehicle(page.vehicle?.value), "year");
  return /^\d{4}$/.test(year) ? year : page.handle?.match(/^(\d{4})(?:-|$)/)?.[1] || "";
}

function compatibilityText(vehicle) {
  const value = vehicle.compatible || vehicle.compat || vehicle.Compatible || vehicle.compatibility || vehicle.Compatibility || "";
  return Array.isArray(value) ? value.join(", ") : String(value).trim();
}

export function escapeXml(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function throttleDelay(json, attempt) {
  const cost = json?.extensions?.cost;
  const status = cost?.throttleStatus;
  const seconds = status?.restoreRate > 0
    ? Math.max(0, (Number(cost.requestedQueryCost || 0) - Number(status.currentlyAvailable || 0)) / status.restoreRate)
    : 0;
  return Math.min(10000, Math.max(1000 * (attempt + 1), Math.ceil(seconds * 1000) + 250));
}

export async function graphqlWithRetry(admin, query, variables = {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    let json;
    try {
      const response = await admin.graphql(query, { variables });
      if (response.status >= 500) {
        if (attempt < 4) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(8000, 1000 * 2 ** attempt)));
          continue;
        }
        throw new Error(`Shopify request failed (${response.status}) after retries.`);
      }
      if (response.status === 429) {
        json = { errors: [{ message: "Shopify throttled the request.", extensions: { code: "THROTTLED" } }] };
      } else {
        json = await response.json();
        if (response.ok === false && !json.errors?.length) throw new Error(`Shopify request failed (${response.status}).`);
      }
    } catch (error) {
      const body = error.body;
      const errors = Array.isArray(body?.errors) ? body.errors : body?.errors?.graphQLErrors;
      if (errors?.length) json = { ...body, errors };
      else if (error.response?.code === 429 || error.response?.status === 429) {
        json = { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] };
      } else {
        const status = Number(error.response?.status || error.response?.code || 0);
        const code = error.code || error.cause?.code;
        const transient = status >= 500 || ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"].includes(code);
        if (transient && attempt < 4) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(8000, 1000 * 2 ** attempt)));
          continue;
        }
        throw error;
      }
    }
    if (json.errors?.length) {
      if (attempt < 4 && json.errors.every((error) => error.extensions?.code === "THROTTLED")) {
        await new Promise((resolve) => setTimeout(resolve, throttleDelay(json, attempt)));
        continue;
      }
      throw new Error(json.errors.map((error) => error.message).join(", "));
    }
    if (!json.data) throw new Error("Shopify returned no feed data.");
    return json.data;
  }
}

function validateConnection(connection, after, resource) {
  if (!Array.isArray(connection?.nodes) || !connection.pageInfo) throw new Error(`Invalid ${resource} response.`);
  if (connection.pageInfo.hasNextPage && (!connection.pageInfo.endCursor || connection.pageInfo.endCursor === after)) {
    throw new Error(`Invalid ${resource} pagination cursor.`);
  }
  return connection;
}

export async function getPageBatch(admin, after = null, year = "") {
  const data = await graphqlWithRetry(admin, PAGE_QUERY, { after, query: year || null });
  return validateConnection(data.pages, after, "pages");
}

async function getProduct(admin, handle, signal) {
  let after = null;
  let product = null;
  const variants = [];
  const seenCursors = new Set();
  do {
    if (signal?.aborted) throw new Error("Feed download cancelled.");
    const data = await graphqlWithRetry(admin, PRODUCT_QUERY, { handle, after });
    if (!data.productByHandle) {
      if (product) throw new Error(`Product ${handle} was removed during the download.`);
      return null;
    }
    product = data.productByHandle;
    const connection = validateConnection(product.variants, after, "variants");
    variants.push(...connection.nodes);
    if (!connection.pageInfo.hasNextPage) break;
    after = connection.pageInfo.endCursor;
    if (seenCursors.has(after)) throw new Error("Repeated variants pagination cursor.");
    seenCursors.add(after);
  } while (true);
  return { ...product, variants: variants.sort((a, b) => (a.position || 0) - (b.position || 0)) };
}

export async function linkedProduct(admin, page, cache, signal) {
  const handles = [...new Set([page.productHandle?.value, page.sourceProductHandle?.value]
    .map((value) => String(value || "").trim()).filter(Boolean))];
  for (const handle of handles) {
    if (!cache.has(handle)) {
      cache.set(handle, await getProduct(admin, handle, signal));
      // Keep memory bounded on stores containing many linked products.
      if (cache.size > 32) cache.delete(cache.keys().next().value);
    }
    const product = cache.get(handle);
    if (product) return product;
  }
  throw new Error(`Page ${page.handle} has no usable linked product. Check ymmt.product_handle and ymmt.source_product_handle.`);
}

export function renderItem(page, product, variant, storefrontUrl, currency) {
  const vehicle = parseVehicle(page.vehicle?.value);
  const compatibility = compatibilityText(vehicle);
  const vehicleName = [pageYear(page), vehicleField(vehicle, "make"), vehicleField(vehicle, "model"), vehicleField(vehicle, "trim")]
    .filter(Boolean).join(" ");
  const title = page.seoTitle?.value || `${product.title} ${vehicleName} - ${TITLE_SUFFIX}`;
  const description = page.seoDescription?.value || [
    `Shop High Quality and Premium Car Seat Covers for ${vehicleName}.`,
    compatibility ? `High-quality covers for ${compatibility}` : "High-quality covers",
    "Luxury Car Seat Covers from Everseats.",
  ].join(" ");
  // Test the compatibility field, rather than titles or unrelated descriptive text.
  const label3 = /\bthird[\s-]+row\b/i.test(compatibility) ? "3 Row Vehicle" : "";
  const color = variant.selectedOptions?.find((option) => /colou?r/i.test(option.name))?.value || "";
  const pattern = product.title.replace(/\s+seat\s+covers?\s*$/i, "").trim();
  const variantId = String(variant.legacyResourceId || variant.id?.split("/").pop() || "");
  const pageId = String(page.id?.split("/").pop() || "");
  if (!variantId || !pageId) throw new Error("A feed item is missing its Shopify variant or page ID.");
  const image = variant.media?.nodes?.find((media) => media.image?.url)?.image.url || product.featuredMedia?.image?.url || "";
  if (!image) throw new Error(`Product ${product.handle}, variant ${variantId} has no image.`);
  if (variant.price == null || !Number.isFinite(Number(variant.price))) throw new Error(`Variant ${variantId} has an invalid price.`);

  // Keep exactly this order. Label 3 is always present, including an empty pair of tags.
  return `    <item>
      <g:id>${escapeXml(`${product.handle}-${variantId}-${pageId}`)}</g:id>
      <g:title>${escapeXml(title)}</g:title>
      <g:description>${escapeXml(description)}</g:description>
      <g:image_link>${escapeXml(image)}</g:image_link>
      <g:condition>new</g:condition>
      <g:availability>${variant.availableForSale ? "in_stock" : "out_of_stock"}</g:availability>
      <g:price>${escapeXml(`${Number(variant.price).toFixed(2)} ${currency}`)}</g:price>
      <g:google_product_category>${escapeXml(CATEGORY)}</g:google_product_category>
      <g:brand>${escapeXml(BRAND)}</g:brand>
      <g:color>${escapeXml(color)}</g:color>
      <g:identifier_exists>FALSE</g:identifier_exists>
      <g:mpn>${escapeXml(variant.sku || "")}</g:mpn>
      <g:custom_label_0>${escapeXml(vehicleField(vehicle, "make"))}</g:custom_label_0>
      <g:custom_label_1>${escapeXml(pattern)}</g:custom_label_1>
      <g:custom_label_2>${escapeXml(color)}</g:custom_label_2>
      <g:custom_label_3>${escapeXml(label3)}</g:custom_label_3>
      <g:product_highlight>${escapeXml(HIGHLIGHTS)}</g:product_highlight>
      <g:link>${escapeXml(`${storefrontUrl}/pages/${page.handle}`)}</g:link>
    </item>
`;
}


export function feedHeader(shop) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>${escapeXml(shop)} - Google Feed</title>
    <link>https://${escapeXml(shop)}</link>
    <description>Google Merchant Center feed for YMMT pages</description>
`;
}
export const FEED_FOOTER = "  </channel>\n</rss>";
