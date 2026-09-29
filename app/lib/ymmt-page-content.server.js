export function buildYMMTPageContent(record) {
  const compat = record.compatible || record.compat || "";

  const vehicle = {
    year: record.year,
    make: record.make,
    model: record.model,
    trim: record.trim || "",

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
  })();
</script>
`.trim();

  return {
    vehicle,
    pageBody,
  };
}
