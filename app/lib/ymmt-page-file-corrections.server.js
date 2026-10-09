import { randomUUID } from "node:crypto";
import { embeddedRecords, isYMMTPage, pageFingerprint } from "./ymmt-page-repair-analysis.server";
import { scanGraphql, withLock } from "./ymmt-page-scan-jobs.server";
import { repairPrefix, readRepairJson, writeRepairJson, uniqueRepairJson, removeRepairObject, repairError } from "./ymmt-page-repair-storage.server";

const fields = ["Warning", "Compatible", "Manufacturer"];
const coordinates = ["year", "make", "model", "trim"];
const prefix = (shop, id = "") => repairPrefix(shop, id).replace(/^ymmt-repairs\//, "ymmt-file-corrections/");
const meta = (shop, id) => `${prefix(shop, id)}/job.json`;
const log = (job, level, message) => { job.logs.push({ time: new Date().toISOString(), level, message }); job.logs = job.logs.slice(-150); };
const safeJson = (value) => JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
const PAGE_FIELDS = `id title handle body templateSuffix isPublished
vehicle: metafield(namespace: "ymmt", key: "vehicle") { id type value }
productHandle: metafield(namespace: "ymmt", key: "product_handle") { id type value }
sourceProductHandle: metafield(namespace: "ymmt", key: "source_product_handle") { id type value }`;
const QUERY = `#graphql
query CheckSavedPageIDs($ids: [ID!]!) { nodes(ids: $ids) { ... on Page { ${PAGE_FIELDS} } } }`;
const UPDATE = `#graphql
mutation CorrectSavedPage($id: ID!, $page: PageUpdateInput!) { pageUpdate(id: $id, page: $page) { page { id } userErrors { field message } } }`;
const planCache = new Map();
export async function fileCorrectionUploadStatus(shop) {
  const lock = await readRepairJson(`${prefix(shop)}/create-lock.json`);
  return { busy: Boolean(lock?.value.until > Date.now()), lockUntil: lock?.value.until || 0 };
}
async function planRows(batch) {
  if (typeof batch === "string") return (await readRepairJson(batch))?.value;
  let rows = planCache.get(batch.key);
  if (!rows) { rows = (await readRepairJson(batch.key))?.value; if (!Array.isArray(rows)) throw new Error("Saved page list is missing."); planCache.set(batch.key, rows); if (planCache.size > 6) planCache.delete(planCache.keys().next().value); }
  return rows.slice(batch.start, batch.end);
}
export async function fileCorrectionStatus(shop, job) {
  if (!job) return null;
  const key = job.phase === "uploading" ? `${prefix(shop)}/create-lock.json` : `${prefix(shop, job.id)}/batch-lock.json`;
  const lock = await readRepairJson(key);
  const { batches, receipts, ...summary } = job;
  const busy = Boolean(lock?.value.until > Date.now());
  return { ...summary, busy, ...(job.phase === "uploading" && !busy ? { phase: "upload_failed", error: "The upload was interrupted. Choose the same files and upload again." } : {}) };
}

export function parseCsv(text) {
  text = text.replace(/^\uFEFF/, "");
  const rows = []; let row = [], cell = "", quoted = false, ended = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; ended = true; } } else cell += c; }
    else if (c === '"') { if (cell || ended) throw new Error("Invalid CSV quote."); quoted = true; }
    else if (c === ",") { row.push(cell); cell = ""; ended = false; }
    else if (c === "\r" || c === "\n") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); if (row.some(Boolean)) rows.push(row); row = []; cell = ""; ended = false; }
    else { if (ended) throw new Error("Invalid text after a CSV quote."); cell += c; }
  }
  if (quoted) throw new Error("The CSV contains an unterminated quoted field.");
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const header = rows.shift() || [];
  if (new Set(header).size !== header.length) throw new Error("Duplicate CSV columns.");
  const required = ["page_id", "handle", "correction_status", ...coordinates.map((k) => `corrected_${k}`)];
  if (required.some((k) => !header.includes(k))) throw new Error("Upload the prepared ymmt-pages-to-correct.csv supplied with this update, rather than the original scan CSV.");
  return rows.map((values) => { if (values.length !== header.length) throw new Error("Inconsistent CSV columns."); return Object.fromEntries(header.map((k, i) => [k, values[i]])); });
}

export function correctionPlan(csvText, jsonText) {
  const json = JSON.parse(jsonText); const index = new Map();
  const object = (v) => v && typeof v === "object" && !Array.isArray(v);
  if (!object(json)) throw new Error("Expected a Year â†’ Make â†’ Model â†’ Trim JSON object.");
  function add(key, leaf) {
    if (!object(leaf) || fields.some((f) => typeof leaf[f] !== "string" || !leaf[f].trim())) throw new Error(`Incomplete corrected values for ${key.join(" / ")}.`);
    index.set(JSON.stringify(key), { ...Object.fromEntries(coordinates.map((k, i) => [k, key[i]])), compatible: leaf.Compatible, compat: leaf.Compatible, warning: leaf.Warning, manufacturer: leaf.Manufacturer });
  }
  for (const [year, makes] of Object.entries(json)) {
    if (!/^\d{4}$/.test(year) || !object(makes)) throw new Error("Invalid year in corrected JSON.");
    for (const [make, models] of Object.entries(makes)) {
      if (!make || !object(models)) throw new Error("Invalid make in corrected JSON.");
      for (const [model, node] of Object.entries(models)) {
        if (!model || !object(node)) throw new Error("Invalid model in corrected JSON.");
        if (fields.some((f) => Object.hasOwn(node, f))) add([year, make, model, ""], node);
        for (const [trim, leaf] of Object.entries(node)) if (!fields.includes(trim)) add([year, make, model, trim], leaf);
      }
    }
  }
  const ids = new Set();
  const rows = parseCsv(csvText).map((row) => {
    if (!/^gid:\/\/shopify\/Page\/\d+$/.test(row.page_id) || !row.handle) throw new Error("Invalid page ID or missing handle in CSV.");
    if (ids.has(row.page_id)) throw new Error("Duplicate page ID in CSV."); ids.add(row.page_id);
    const target = row.correction_status === "verified" ? index.get(JSON.stringify(coordinates.map((k) => row[`corrected_${k}`]))) : null;
    if (row.correction_status === "verified" && !target) throw new Error(`The corrected JSON has no exact vehicle match for ${row.handle}.`);
    return { id: row.page_id, handle: row.handle, target: target || null, reason: target ? "" : "Vehicle match needs manual review; no automatic correction." };
  });
  if (!rows.length || rows.length > 60000) throw new Error("CSV must contain 1â€“60,000 pages.");
  return rows;
}

export function proposeCorrection(page, row) {
  if (!page || page.id !== row.id) return { issues: ["Page no longer exists."], blocked: true };
  if (page.handle !== row.handle || !isYMMTPage(page)) return { issues: ["Page identity or type changed since the CSV export."], blocked: true };
  if (!row.target) return { issues: [row.reason], blocked: true };
  if (page.vehicle?.type && page.vehicle.type !== "json") return { issues: ["ymmt.vehicle is not a JSON metafield; review its definition."], blocked: true };
  const target = row.target; let vehicle;
  try { vehicle = JSON.parse(page.vehicle?.value || "{}"); } catch { vehicle = {}; }
  if (!vehicle || typeof vehicle !== "object" || Array.isArray(vehicle)) vehicle = {};
  const value = { ...vehicle, ...target };
  // Synchronize existing aliases too; preserve product/pattern and other custom fields.
  for (const [alias, canonical] of Object.entries({ Year: "year", Make: "make", Model: "model", Trim: "trim", Compatible: "compatible", Compatibility: "compatible", compatibility: "compatible", Warning: "warning", Manufacturer: "manufacturer" })) if (Object.hasOwn(value, alias)) value[alias] = target[canonical];
  const issues = []; const differences = [];
  for (const k of Object.keys(target)) if (vehicle[k] !== target[k]) { issues.push(`ymmt.vehicle.${k}`); differences.push({ field: `ymmt.vehicle.${k}`, current: vehicle[k] ?? "", expected: target[k] }); }
  let body = String(page.body || "");
  const blocks = embeddedRecords(body);
  const hasId = /\b(?:var|let|const)\s+VEHICLE_ID\s*=\s*("(?:[^"\\]|\\.)*")/.test(body);
  if (!blocks.some((b) => b.name === "DATA") || !blocks.some((b) => b.name === "VEHICLE_REC") || !hasId) return { issues: [...issues, "Unsupported page script; needs manual review."], blocked: true };
  for (const block of [...blocks].reverse()) {
    const updated = { ...block.value, ...target };
    for (const [alias, canonical] of Object.entries({ Year: "year", Make: "make", Model: "model", Trim: "trim", Compatible: "compatible", Compatibility: "compatible", compatibility: "compatible", Warning: "warning", Manufacturer: "manufacturer" })) if (Object.hasOwn(updated, alias)) updated[alias] = target[canonical];
    for (const k of Object.keys(target)) if (block.value[k] !== target[k]) { issues.push(`body.${block.name}.${k}`); differences.push({ field: `body.${block.name}.${k}`, current: block.value[k] ?? "", expected: target[k] }); }
    if (JSON.stringify(updated) !== JSON.stringify(block.value)) body = body.slice(0, block.start) + safeJson(updated) + body.slice(block.end);
  }
  const id = coordinates.map((k) => target[k]).join("_GAP_");
  body = body.replace(/(\b(?:var|let|const)\s+VEHICLE_ID\s*=\s*)("(?:[^"\\]|\\.)*")/g, (assignment, start, encoded) => { if (JSON.parse(encoded) === id) return assignment; issues.push("body.VEHICLE_ID"); return start + safeJson(id); });
  const changed = body !== (page.body || "") || JSON.stringify(vehicle) !== JSON.stringify(value);
  return { issues: [...new Set(issues)], differences, blocked: false, changed, fingerprint: pageFingerprint(page), input: { body, metafields: [page.vehicle?.id ? { id: page.vehicle.id, value: JSON.stringify(value) } : { namespace: "ymmt", key: "vehicle", type: "json", value: JSON.stringify(value) }] } };
}

export async function getFileCorrectionJob(shop, id) {
  const entry = await readRepairJson(meta(shop, id));
  if (entry && (entry.value.shop !== shop || entry.value.id !== id)) throw new Error("Correction ownership mismatch.");
  return entry?.value || null;
}
export async function latestFileCorrectionJob(shop) {
  const entry = await readRepairJson(`${prefix(shop)}/latest.json`);
  return entry ? getFileCorrectionJob(shop, entry.value.id) : null;
}
export async function createFileCorrectionJob(shop, csvText, jsonText) {
  const rows = correctionPlan(csvText, jsonText);
  return withLock(`${prefix(shop)}/create-lock.json`, async (owner) => {
    const current = await latestFileCorrectionJob(shop);
    // Owning the create lock means an unfinished prior upload has stopped.
    if (current && ["checking", "correcting"].includes(current.phase)) return current;
    const job = { id: randomUUID(), shop, phase: "uploading", status: "paused", error: "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), logs: [], batches: [], receipts: {}, batch: 0, requestCount: 0, total: rows.length, uploaded: 0, checked: 0, needsCorrection: 0, correct: 0, skipped: 0, corrected: 0, unchanged: 0, changed: 0, failed: 0, processed: 0 };
    log(job, "info", `Preparing ${rows.length} saved page IDs. Upload progress updates automatically.`);
    let etag = await writeRepairJson(meta(shop, job.id), job, { IfNoneMatch: "*" });
    await writeRepairJson(`${prefix(shop)}/latest.json`, { id: job.id });
    try {
      // Store up to 1,000 rows per object, while keeping Shopify batches at 10.
      // Previously an upload wrote 2,568 objects before publishing its first log.
      for (let i = 0; i < rows.length; i += 1000) {
        owner();
        const group = rows.slice(i, i + 1000); const key = await uniqueRepairJson(`${prefix(shop, job.id)}/plans`, group);
        for (let start = 0; start < group.length; start += 10) job.batches.push({ key, start, end: Math.min(group.length, start + 10) });
        job.uploaded += group.length; job.updatedAt = new Date().toISOString();
        log(job, "info", `Saved upload: ${job.uploaded}/${job.total} page IDs.`);
        owner(); etag = await writeRepairJson(meta(shop, job.id), job, { IfMatch: etag });
      }
    } catch (error) { owner(); job.phase = "upload_failed"; job.error = repairError(error); job.updatedAt = new Date().toISOString(); log(job, "error", `Upload failed. Choose your files again. ${job.error}`); await writeRepairJson(meta(shop, job.id), job, { IfMatch: etag }); throw error; }
    job.phase = "checking"; job.updatedAt = new Date().toISOString();
    log(job, "info", `Loaded ${rows.length} saved page IDs. Checks use these IDs only; no whole-store or product search.`);
    await writeRepairJson(meta(shop, job.id), job, { IfMatch: etag });
    return job;
  });
}
export async function advanceFileCorrectionJob(shop, id, admin, intent = "advance") {
  return withLock(`${prefix(shop, id)}/batch-lock.json`, async (owner) => {
    const entry = await readRepairJson(meta(shop, id));
    if (!entry || entry.value.shop !== shop) throw new Error("Correction job not found.");
    let job = entry.value, etag = entry.etag, committed = structuredClone(job);
    const save = async () => { owner(); job.updatedAt = new Date().toISOString(); job.error = ""; job.status = "paused"; etag = await writeRepairJson(meta(shop, id), job, { IfMatch: etag }); committed = structuredClone(job); };
    try {
      if (intent === "correct") {
        if (job.phase !== "review") throw new Error("Complete Check Pages before correcting fields.");
        job.phase = "correcting"; job.batch = 0; log(job, "info", "Correction started. Only reviewed fields will be changed; each update is verified."); await save(); return job;
      }
      if (intent === "retry-failed") {
        if (job.phase !== "complete" || !job.failed) throw new Error("Finish the correction pass before retrying failed pages.");
        job.phase = "correcting"; job.retryFailed = true; job.batch = 0; log(job, "info", "Retrying only failed pages; completed corrections are retained."); await save(); return job;
      }
      if (intent !== "advance" || !["checking", "correcting"].includes(job.phase)) throw new Error("No active check or correction to advance.");
      const rows = await planRows(job.batches[job.batch]);
      if (!Array.isArray(rows)) throw new Error("Saved page list is missing.");
      const previous = job.receipts[job.batch];
      const receipts = previous ? (await readRepairJson(previous))?.value : {};
      if (!receipts || typeof receipts !== "object") throw new Error("Saved results are missing.");
      const ids = rows.filter((r) => r.target && (job.phase === "checking" || (receipts[r.id]?.state === "needsCorrection" && (!receipts[r.id]?.result || (job.retryFailed && receipts[r.id]?.result === "failed"))))).map((r) => r.id);
      const data = ids.length ? await scanGraphql(admin, QUERY, { ids }, job, owner) : { nodes: [] };
      if (!Array.isArray(data.nodes) || data.nodes.length !== ids.length) throw new Error("Shopify returned an incomplete ID batch.");
      const pages = new Map(data.nodes.filter(Boolean).map((p) => [p.id, p]));
      const persistResults = async () => { const old = job.receipts[job.batch]; job.receipts[job.batch] = await uniqueRepairJson(`${prefix(shop, id)}/results`, receipts); await save(); await removeRepairObject(old); };
      for (const row of rows) {
        if (job.phase === "checking") {
          if (receipts[row.id]) continue;
          const p = row.target ? proposeCorrection(pages.get(row.id), row) : { blocked: true, issues: [row.reason] };
          const state = p.blocked ? "skipped" : p.changed ? "needsCorrection" : "correct";
          job[state]++; job.checked++;
          receipts[row.id] = { state, issues: p.issues, differences: p.differences || [], fingerprint: p.fingerprint || null, target: row.target };
        } else {
          const receipt = receipts[row.id];
          if (receipt?.state !== "needsCorrection" || (receipt.result && !(job.retryFailed && receipt.result === "failed"))) continue;
          let result, message = "";
          const page = pages.get(row.id); const proposal = proposeCorrection(page, row);
          if (!proposal.blocked && !proposal.changed) result = "unchanged";
          else if (proposal.blocked || proposal.fingerprint !== receipt.fingerprint) { result = "changed"; message = "Page changed after Check Pages; skipped. Check it again before correcting."; }
          else {
            const backup = `${prefix(shop, id)}/backups/${row.id.split("/").pop()}.json`;
            if (!(await readRepairJson(backup))) await writeRepairJson(backup, page, { IfNoneMatch: "*" });
            try {
              const response = await scanGraphql(admin, UPDATE, { id: row.id, page: proposal.input }, job, owner);
              if (response.pageUpdate?.userErrors?.length) throw new Error(response.pageUpdate.userErrors.map((e) => e.message).join("; "));
              if (response.pageUpdate?.page?.id !== row.id) throw new Error("Shopify did not confirm the update.");
              const verified = await scanGraphql(admin, QUERY, { ids: [row.id] }, job, owner);
              const after = verified.nodes?.[0]; const diff = proposeCorrection(after, row);
              if (diff.blocked || diff.changed || after.productHandle?.value !== page.productHandle?.value || after.sourceProductHandle?.value !== page.sourceProductHandle?.value) throw new Error("Updated values could not be verified; check this page before retrying.");
              result = "corrected";
            } catch (error) { result = "failed"; message = repairError(error); }
          }
          if (receipt.result === "failed") { job.failed--; job.processed--; }
          receipts[row.id] = { ...receipt, result, message }; job[result]++; job.processed++;
          log(job, result === "failed" ? "error" : "info", `${row.handle}: ${result}${message ? ` â€” ${message}` : ""}`);
          await persistResults();
        }
      }
      if (job.phase === "checking") log(job, "success", `Checked ${job.checked}/${job.total}; ${job.needsCorrection} need correction, ${job.correct} correct, ${job.skipped} need manual review.`);
      await persistResults(); job.batch++;
      if (job.batch >= job.batches.length) { job.phase = job.phase === "checking" ? "review" : "complete"; job.retryFailed = false; log(job, "success", job.phase === "review" ? "Check complete. Review the differences, then click Correct Fields." : "Correction complete. Updated fields were reread and verified."); }
      await save(); return job;
    } catch (error) { job = structuredClone(committed); job.status = "failed"; job.error = repairError(error); log(job, "error", job.error); job.updatedAt = new Date().toISOString(); owner(); await writeRepairJson(meta(shop, id), job, { IfMatch: etag }); return job; }
  });
}
export async function fileCorrectionView(job, offset = 0) {
  if (!job) return null;
  offset = Math.max(0, Math.floor(Number(offset) || 0));
  const rows = []; let count = 0;
  for (let i = 0; i < job.batches.length; i++) {
    if (!job.receipts[i]) continue;
    const data = (await readRepairJson(job.receipts[i]))?.value;
    if (!data) throw new Error("Saved check results are missing.");
    const plans = await planRows(job.batches[i]);
    for (const p of plans) { const r = data[p.id]; if (!r || r.state === "correct") continue; if (count++ < offset) continue; rows.push({ id: p.id, handle: p.handle, adminUrl: `https://${job.shop}/admin/pages/${p.id.split("/").pop()}`, ...r }); if (rows.length === 25) break; }
    if (rows.length === 25) break;
  }
  const { batches, receipts, shop, ...view } = job;
  return { ...view, rows, offset, issueCount: job.needsCorrection + job.skipped };
}
