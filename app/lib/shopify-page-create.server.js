export async function createYMMTPage(
  admin,
  { title, handle, record, sourceProductHandle },
) {
  const compat = record.compatible || "";

  const vehicle = {
    year: record.year,
    make: record.make,
    model: record.model,
    trim: record.trim || "",

    // Keep both formats for compatibility.
    compat,
    compatible: compat,

    warning: record.warning,
    manufacturer: record.manufacturer,
  };

  const vehicleId = [record.year, record.make, record.model, record.trim || ""]
    .map((value) => String(value || "").trim())
    .join("_GAP_");

  const sessionData = {
    year: String(record.year || ""),
    make: String(record.make || ""),
    model: String(record.model || ""),
    trim: String(record.trim || ""),
    compat: String(compat || ""),
    warning: String(record.warning || ""),
  };

  const vehicleRecord = {
    year: String(record.year || ""),
    make: String(record.make || ""),
    model: String(record.model || ""),
    trim: String(record.trim || ""),

    compat: String(compat || ""),
    compatible: String(compat || ""),

    warning: String(record.warning || ""),

    selected: true,
  };

  const pageBody = `
<script>
  (function () {
    var DATA = ${JSON.stringify(sessionData)};
    var VEHICLE_ID = ${JSON.stringify(vehicleId)};
    var VEHICLE_REC = ${JSON.stringify(vehicleRecord)};

    function apply() {
      try {
        var ss = window.sessionStorage;

        ss.setItem("user_year", DATA.year);
        ss.setItem("user_make", DATA.make);
        ss.setItem("user_model", DATA.model);
        ss.setItem("user_trim", DATA.trim);
        ss.setItem("user_compat", DATA.compat);
        ss.setItem("user_warning", DATA.warning);

        var vehicles = {};

        try {
          vehicles =
            JSON.parse(
              ss.getItem("user_vehicles") || "{}"
            ) || {};
        } catch (e) {
          vehicles = {};
        }

        Object.keys(vehicles).forEach(function (key) {
          if (
            vehicles[key] &&
            typeof vehicles[key] === "object"
          ) {
            vehicles[key].selected = false;
          }
        });

        vehicles[VEHICLE_ID] = VEHICLE_REC;

        ss.setItem(
          "user_vehicles",
          JSON.stringify(vehicles)
        );
      } catch (e) {
        // sessionStorage unavailable
      }
    }

    apply();

    if (document.readyState === "loading") {
      document.addEventListener(
        "DOMContentLoaded",
        apply,
        { once: true }
      );
    }

    window.addEventListener(
      "load",
      apply,
      { once: true }
    );

    window.addEventListener(
      "pageshow",
      apply,
      { once: true }
    );

    // Intentionally do not set localStorage.HomeSearch here.
  })();
</script>
`.trim();

  const fallbackUrl = sourceProductHandle
    ? `/products/${sourceProductHandle}`
    : "";

  const response = await admin.graphql(
    `#graphql
      mutation CreateYMMTPage($page: PageCreateInput!) {
        pageCreate(page: $page) {
          page {
            id
            title
            handle
          }

          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      variables: {
        page: {
          title,
          handle,
          isPublished: true,
          templateSuffix: "product-ymmt",

          body: pageBody,

          metafields: [
            {
              namespace: "ymmt",
              key: "source_product_handle",
              type: "single_line_text_field",
              value: sourceProductHandle || "",
            },
            {
              namespace: "ymmt",
              key: "product_handle",
              type: "single_line_text_field",
              value: sourceProductHandle || "",
            },
            {
              namespace: "ymmt",
              key: "embed_kind",
              type: "single_line_text_field",
              value: sourceProductHandle ? "product" : "collection",
            },
            {
              namespace: "ymmt",
              key: "fallback_url",
              type: "single_line_text_field",
              value: fallbackUrl,
            },
            {
              namespace: "ymmt",
              key: "vehicle",
              type: "json",
              value: JSON.stringify(vehicle),
            },
          ],
        },
      },
    },
  );

  const json = await response.json();

  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join(", "));
  }

  const result = json.data?.pageCreate;

  if (result?.userErrors?.length) {
    throw new Error(result.userErrors.map((e) => e.message).join(", "));
  }

  if (!result?.page) {
    throw new Error("Shopify did not return the created page.");
  }

  return result.page;
}
