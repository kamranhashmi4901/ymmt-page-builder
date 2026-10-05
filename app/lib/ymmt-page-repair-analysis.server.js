import { createHash } from "node:crypto";
import { buildYMMTPageContent } from "./ymmt-page-content.server";

const aliases = {
  year: ["year", "Year"], make: ["make", "Make"], model: ["model", "Model"], trim: ["trim", "Trim"],
  compat: ["compatible", "compat", "compatibility", "Compatible", "Compatibility"],
  warning: ["warning", "Warning"], manufacturer: ["manufacturer", "Manufacturer"],
};
const text = (value) => Array.isArray(value) ? value.join(", ").trim() : String(value ?? "").trim();
function field(record, key) { return aliases[key].map((name) => text(record?.[name])).find(Boolean) || ""; }
function parseObject(value) {
  try { const result = JSON.parse(value || "null"); return result && typeof result === "object" && !Array.isArray(result) ? result : null; }
  catch { return null; }
}

// Read JSON only; never execute scripts from Shopify page bodies.
export function embeddedRecords(body) {
  const records = [];
  const re = /\b(?:var|let|const)\s+(DATA|VEHICLE_REC)\s*=\s*/g;
  for (const match of String(body || "").matchAll(re)) {
    const start = match.index + match[0].length;
    if (body[start] !== "{") continue;
    let depth = 0; let quoted = false; let escaped = false;
    for (let i = start; i < body.length; i++) {
      const ch = body[i];
      if (quoted) { if (escaped) escaped = false; else if (ch === "\\") escaped = true; else if (ch === '"') quoted = false; }
      else if (ch === '"') quoted = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        const value = parseObject(body.slice(start, i + 1));
        if (value) records.push({ name: match[1], start, end: i + 1, value });
        break;
      }
    }
  }
  return records;
}
function decode(value) {
  return value.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/g, "'");
}
function descriptionRecord(body) {
  const plain = decode(String(body || "").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(?:p|div|li|tr|h[1-6])>|<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, " "));
  const result = {};
  const names = { year: "Year", make: "Make", model: "Model", trim: "Trim", compat: "Compatibility|Compatible", warning: "Warning", manufacturer: "Manufacturer" };
  for (const [key, label] of Object.entries(names)) {
    const match = plain.match(new RegExp(`(?:^|\\n)\\s*(?:${label})\\s*:\\s*([^\\n]+)`, "i"));
    if (match) result[key] = match[1].trim();
  }
  return result;
}
const safeJson = (value) => JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
function safeBody(record) {
  const { pageBody } = buildYMMTPageContent(record);
  let body = pageBody;
  for (const block of embeddedRecords(body).reverse()) body = body.slice(0, block.start) + safeJson(block.value) + body.slice(block.end);
  // VEHICLE_ID is also embedded as a JSON string.
  body = body.replace(/(var VEHICLE_ID = )("(?:[^"\\]|\\.)*")/, (_, prefix, value) => prefix + safeJson(JSON.parse(value)));
  return body;
}
export function pageFingerprint(page) {
  return createHash("sha256").update(JSON.stringify({ body: page.body || "", vehicle: page.vehicle?.value || "", product: page.productHandle?.value || "", source: page.sourceProductHandle?.value || "", template: page.templateSuffix, handle: page.handle, title: page.title, isPublished: page.isPublished })).digest("hex");
}
export function isYMMTPage(page) {
  if (page.templateSuffix === "product-ymmt" || page.vehicle?.value || page.productHandle?.value || page.sourceProductHandle?.value) return true;
  return /^\d{4}-/.test(page.handle || "") && embeddedRecords(page.body || "").some(({ value }) => field(value, "year") && field(value, "make") && field(value, "model"));
}

export function analysePage(page, products, shop) {
  const catalogKnown = Array.isArray(products);
  products = products || [];
  const catalog = new Map(products.map((product) => [product.handle, product]));
  const issues = []; const unresolved = []; const changes = []; const evidence = [];
  if (page.templateSuffix !== "product-ymmt") {
    issues.push("page.templateSuffix (not product-ymmt)");
    unresolved.push("Review the page template in Shopify; the audit preserves existing template choices.");
  }
  const original = parseObject(page.vehicle?.value);
  const records = embeddedRecords(page.body || "");
  const sources = [...records.map((r) => r.value), descriptionRecord(page.body)];
  const recovered = original ? { ...original } : {};
  const normalized = {};
  for (const key of Object.keys(aliases)) {
    let existing = field(original, key);
    if (key === "year" && !/^\d{4}$/.test(existing)) existing = "";
    const alternatives = [...new Set(sources.map((r) => field(r, key)).filter(Boolean))];
    if (key === "year" && !existing && !alternatives.length) {
      const year = page.handle?.match(/^(\d{4})-/)?.[1]; if (year) alternatives.push(year);
    }
    normalized[key] = existing || (alternatives.length === 1 ? alternatives[0] : "");
    if (key === "year" && normalized.year && !/^\d{4}$/.test(normalized.year)) normalized.year = "";
    if (!existing && alternatives.length > 1) unresolved.push(`Conflicting ${key} values in page content.`);
    // Optional trim, warning and manufacturer are restored only if present in a source.
    if (!existing && normalized[key]) {
      recovered[key === "compat" ? "compatible" : key] = normalized[key];
      if (key === "compat") recovered.compat = normalized.compat;
      evidence.push(`${key}: existing page content${key === "year" ? " or year prefix" : ""}`);
    }
  }
  const required = ["year", "make", "model", "compat"];
  for (const key of ["trim", "warning", "manufacturer"]) if (!field(original, key) && normalized[key]) issues.push(`ymmt.vehicle.${key} (recoverable missing value)`);
  for (const key of required) if (!field(original, key) || (key === "year" && !/^\d{4}$/.test(field(original, key)))) issues.push(`ymmt.vehicle.${key === "compat" ? "compatible" : key}`);
  if (!original) issues.push("ymmt.vehicle (missing or invalid JSON)");
  const completeVehicle = required.every((key) => normalized[key]);
  if ((!original || JSON.stringify(original) !== JSON.stringify(recovered)) && completeVehicle) {
    changes.push({ field: "ymmt.vehicle", type: page.vehicle?.type || "json", value: JSON.stringify(recovered) });
  }
  for (const key of required) if (!normalized[key]) unresolved.push(`Cannot verify ${key} from the page's existing data.`);

  const handles = [page.productHandle?.value, page.sourceProductHandle?.value].map(text);
  const handleFormat = (handle) => /^[a-z0-9][a-z0-9-]*$/.test(handle);
  const usable = (handle) => catalogKnown ? catalog.has(handle) : handleFormat(handle);
  const valid = [...new Set(handles.filter(usable))];
  const suffix = products.filter((p) => page.handle?.endsWith(`-${p.handle}`));
  const contentHandles = [...String(page.body || "").matchAll(/(?:href|data-product-url)\s*=\s*["'](?:https?:\/\/[^/"']+)?\/products\/([a-z0-9-]+)(?=[\/\?\#"'])/gi)].map((match) => match[1]);
  const slug = (value) => text(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const vehicleParts = [normalized.year, normalized.make, normalized.model];
  const prefixes = vehicleParts.every(Boolean) ? [vehicleParts, [...vehicleParts, normalized.trim]].map((parts) => parts.filter(Boolean).map(slug).join("-")).sort((a, b) => b.length - a.length) : [];
  const prefix = prefixes.find((value) => page.handle?.startsWith(`${value}-`));
  const inferredHandle = prefix ? page.handle.slice(prefix.length + 1) : "";
  const pageCandidates = [...new Set([...contentHandles, ...(handleFormat(inferredHandle) ? [inferredHandle] : [])])];
  // A longer handle is more specific, but overlapping matches can be ambiguous.
  const candidate = valid.length === 1 ? valid[0] : valid.length === 0 && (catalogKnown ? suffix.length === 1 : pageCandidates.length === 1) ? (catalogKnown ? suffix[0].handle : pageCandidates[0]) : "";
  for (let index = 0; index < handles.length; index++) {
    if (usable(handles[index])) continue;
    const key = index === 0 ? "product_handle" : "source_product_handle";
    issues.push(`ymmt.${key}${handles[index] ? catalogKnown ? " (product not found)" : " (invalid handle format)" : " (missing)"}`);
    if (candidate) {
      const meta = index === 0 ? page.productHandle : page.sourceProductHandle;
      changes.push({ field: `ymmt.${key}`, type: meta?.type || "single_line_text_field", value: candidate });
      evidence.push(`${key}: ${valid.length ? "existing product handle" : "page content or vehicle-prefix suffix"}${catalogKnown ? " (catalog verified)" : " (product existence checked only before applying)"}`);
    } else unresolved.push(`No unique verified product match for ymmt.${key}.`);
  }

  let body = page.body || "";
  if (!body.trim()) {
    issues.push("page.body (empty)");
    if (completeVehicle) { body = safeBody({ ...normalized, compatible: normalized.compat }); changes.push({ field: "page.body", value: body }); }
    else unresolved.push("Cannot rebuild an empty page body without verified vehicle and compatibility data.");
  } else {
    // Fill missing values inside existing known JSON blocks, preserving all other HTML.
    let changed = false;
    for (const block of records) {
      for (const key of ["year", "make", "model", "compat"]) {
        const existing = field(block.value, key);
        if (existing && normalized[key] && existing !== normalized[key]) {
          issues.push(`page.body.${block.name}.${key} (conflicting value)`);
          unresolved.push(`${block.name}.${key} conflicts with the verified vehicle data; review it manually.`);
        }
      }
    }
    if (!records.length) {
      issues.push("page.body (no supported vehicle JSON block)");
      unresolved.push("Existing body has no DATA or VEHICLE_REC JSON block. Its custom content needs manual review.");
    }
    for (const block of [...records].reverse()) {
      const value = { ...block.value }; let blockChanged = false;
      for (const key of ["year", "make", "model", "trim", "compat", "warning"]) {
        if (text(value[key])) continue;
        if (!["year", "make", "model", "compat"].includes(key) && !normalized[key]) continue;
        issues.push(`page.body.${block.name}.${key}`);
        if (normalized[key]) { value[key] = normalized[key]; blockChanged = true; }
        else unresolved.push(`Missing ${key} in ${block.name} cannot be verified.`);
      }
      if (block.name === "VEHICLE_REC" && !text(value.compatible) && normalized.compat) {
        issues.push("page.body.VEHICLE_REC.compatible");
        value.compatible = normalized.compat; blockChanged = true;
      }
      if (blockChanged) { body = body.slice(0, block.start) + safeJson(value) + body.slice(block.end); changed = true; }
    }
    // The storage key must agree with the recovered vehicle record. Update only
    // a known JSON string assignment, never execute or rewrite custom scripts.
    if (completeVehicle && !unresolved.some((issue) => issue.includes("conflicts with"))) {
      const expectedId = [normalized.year, normalized.make, normalized.model, normalized.trim || ""].join("_GAP_");
      body = body.replace(/(\b(?:var|let|const)\s+VEHICLE_ID\s*=\s*)("(?:[^"\\]|\\.)*")/g, (assignment, prefix, encoded) => {
        try {
          if (JSON.parse(encoded) === expectedId) return assignment;
          issues.push("page.body.VEHICLE_ID (does not match vehicle)");
          changed = true; return prefix + safeJson(expectedId);
        } catch { return assignment; }
      });
    }
    if (changed) changes.push({ field: "page.body", value: body });
  }
  return {
    id: page.id, handle: page.handle, title: page.title || "", url: `https://${shop}/pages/${page.handle}`,
    adminUrl: `https://${shop}/admin/pages/${page.id.split("/").pop()}`,
    fingerprint: pageFingerprint(page), issues: [...new Set(issues)], unresolved: [...new Set(unresolved)],
    changes, evidence: [...new Set(evidence)],
    current: { productHandle: handles[0], sourceProductHandle: handles[1], vehicle: page.vehicle?.value || "" },
    proposedProduct: candidate, repairable: changes.length > 0,
    productValidation: catalogKnown ? "Catalog scanned" : "Handle format only; existing product existence is not checked during this page-only scan",
    exportVehicle: {
      year: normalized.year, make: normalized.make, model: normalized.model, trim: normalized.trim || "",
      Warning: normalized.warning || "", Compatible: normalized.compat || "", Manufacturer: normalized.manufacturer || "",
    },
  };
}
