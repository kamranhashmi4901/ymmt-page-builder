import { randomUUID } from "node:crypto";
import { repairPrefix, readRepairJson, writeRepairJson } from "./ymmt-page-repair-storage.server";
import { buildYMMTVehicleHandleBase } from "./ymmt-pages";

const sourceKey = (shop, id) => `${repairPrefix(shop, id).replace(/^ymmt-repairs\//, "ymmt-manage-json/")}/source.json`;
const coordinateKey = (record) => JSON.stringify([record.year, record.make, record.model, record.trim || ""].map((v) => String(v || "").trim().toLowerCase()));

export function canonicalManageRecord(record) {
  const target = {
    year: String(record.year ?? record.Year ?? "").trim(),
    make: String(record.make ?? record.Make ?? "").trim(),
    model: String(record.model ?? record.Model ?? "").trim(),
    trim: String(record.trim ?? record.Trim ?? "").trim(),
    compatible: String(record.compatible ?? record.compat ?? record.Compatible ?? "").trim(),
    warning: String(record.warning ?? record.Warning ?? "").trim(),
    manufacturer: String(record.manufacturer ?? record.Manufacturer ?? "").trim(),
  };
  target.compat = target.compatible;
  if (!/^\d{4}$/.test(target.year) || !target.make || !target.model || !target.compatible || !target.warning || !target.manufacturer) throw new Error("The uploaded JSON must include complete compatibility, warning and manufacturer values for every vehicle.");
  return target;
}

export async function saveManageJsonSource(shop, records, fileName) {
  const canonical = records.map(canonicalManageRecord);
  if (!canonical.length || canonical.length > 60000) throw new Error("JSON must contain 1–60,000 vehicles.");
  const id = randomUUID();
  await writeRepairJson(sourceKey(shop, id), { id, shop, fileName, records: canonical }, { IfNoneMatch: "*" });
  return id;
}

export async function loadManageJsonSource(shop, id) {
  if (!id) throw new Error("Search using your corrected JSON again before updating content. This update requires the saved JSON source.");
  const entry = await readRepairJson(sourceKey(shop, id));
  if (!entry || entry.value.shop !== shop || entry.value.id !== id) throw new Error("The saved JSON source is unavailable. Search using your corrected JSON again.");
  return indexManageJsonSource(entry.value.records);
}

export function indexManageJsonSource(records) {
  const byCoordinates = new Map(), byHandle = new Map();
  for (const raw of records) {
    const record = canonicalManageRecord(raw), key = coordinateKey(record);
    const handle = buildYMMTVehicleHandleBase(record);
    const existing = byCoordinates.get(key);
    if (existing && JSON.stringify(existing) !== JSON.stringify(record)) throw new Error("The JSON has conflicting vehicle records. Resolve them before updating pages.");
    byCoordinates.set(key, record);
    if (!byHandle.has(handle)) byHandle.set(handle, new Map());
    byHandle.get(handle).set(key, record);
  }
  return { byCoordinates, handles: [...byHandle].sort((a, b) => b[0].length - a[0].length) };
}

export function matchManageJsonSource(page, source) {
  if (!page || page.templateSuffix !== "product-ymmt") throw new Error("This is not a YMMT page.");
  const handle = String(page.handle || "").toLowerCase();
  const handleMatches = source.handles.find(([base]) => handle === base || handle.startsWith(`${base}-`));
  let vehicle = {};
  try { vehicle = JSON.parse(page.vehicle?.value || "{}"); } catch { /* Handle matching supports legacy pages. */ }
  const metadataMatch = source.byCoordinates.get(coordinateKey(vehicle || {}));
  if (handleMatches) {
    const candidates = [...handleMatches[1].values()];
    if (candidates.length !== 1) throw new Error("Multiple uploaded vehicles produce this handle. Review the page manually.");
    const match = candidates[0];
    if (metadataMatch && coordinateKey(metadataMatch) !== coordinateKey(match)) throw new Error("Page handle and vehicle metafield identify different uploaded vehicles. Review the page manually.");
    return match;
  }
  if (metadataMatch) return metadataMatch;
  throw new Error("No matching vehicle exists in the saved JSON. This page was not updated.");
}
