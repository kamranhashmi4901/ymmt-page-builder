export function slugify(value) {
  return String(value || "")
    .trim()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/&/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/*
 * Returns the real trim value used for page creation.
 *
 * Rules:
 * - Empty / null trim -> no trim segment
 * - "All" -> no trim segment
 * - "Base" -> KEEP it because Base is a real trim
 * - Any other trim -> keep it
 */
function getPageTrim(record) {
  const value = String(record.trim || "").trim();

  if (!value) {
    return null;
  }

  const normalized = value.toLowerCase();

  if (normalized === "all") {
    return null;
  }

  /*
   * SCS uses "Base" as the default/no-specific-trim
   * record when merged with trim-specific data.
   *
   * Existing live URLs therefore omit it.
   */
  if (
    normalized === "base" &&
    String(record.manufacturer || "")
      .trim()
      .toLowerCase() === "scs"
  ) {
    return null;
  }

  /*
   * EKR Base is an actual trim.
   */
  return value;
}

/*
 * Builds only the vehicle portion of a YMMT handle.
 *
 * Examples:
 *
 * 1999 Honda Accord / Base
 * -> 1999-honda-accord-base
 *
 * 1999 Toyota Avalon / no trim
 * -> 1999-toyota-avalon
 */
export function buildYMMTVehicleHandleBase(record) {
  const trim = getPageTrim(record);

  return [record.year, record.make, record.model, trim]
    .filter(Boolean)
    .map(slugify)
    .join("-");
}

/*
 * Builds the complete Shopify page handle.
 *
 * Example:
 * 1999-honda-accord-base-luxeline-seat-covers
 */
export function buildYMMTPageHandle(record, productHandle) {
  const vehicleHandle = buildYMMTVehicleHandleBase(record);
  const normalizedProductHandle = slugify(productHandle);

  if (!normalizedProductHandle) {
    return vehicleHandle;
  }

  return `${vehicleHandle}-${normalizedProductHandle}`;
}

/*
 * Builds the human-readable page title.
 *
 * Base is included when Base is the actual trim.
 * Missing trim stays missing.
 */
export function buildYMMTPageTitle(record, productHandle) {
  const trim = getPageTrim(record);

  return [record.year, record.make, record.model, trim, productHandle || null]
    .filter(Boolean)
    .join(" ");
}
