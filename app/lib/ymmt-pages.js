export function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function getPageTrim(trim) {
  const value = String(trim || "").trim();

  if (!value) {
    return null;
  }

  const normalized = value.toLowerCase();

  if (normalized === "all" || normalized === "base") {
    return null;
  }

  return value;
}

export function buildYMMTPageHandle(record, productHandle) {
  const trim = getPageTrim(record.trim);

  return [record.year, record.make, record.model, trim, productHandle || null]
    .filter(Boolean)
    .map(slugify)
    .join("-");
}

export function buildYMMTPageTitle(record, productHandle) {
  const trim = getPageTrim(record.trim);

  return [record.year, record.make, record.model, trim, productHandle || null]
    .filter(Boolean)
    .join(" ");
}
