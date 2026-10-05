import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { analysePage, embeddedRecords, isYMMTPage, pageFingerprint } from "./ymmt-page-repair-analysis.server";
import { repairPrefix, readRepairJson, writeRepairJson, uniqueRepairJson, removeRepairObject, repairError } from "./ymmt-page-repair-storage.server";

const PAGE_FIELDS = `id title handle body templateSuffix isPublished
  vehicle: metafield(namespace: "ymmt", key: "vehicle") { id type value }
  productHandle: metafield(namespace: "ymmt", key: "product_handle") { id type value }
  sourceProductHandle: metafield(namespace: "ymmt", key: "source_product_handle") { id type value }`;
const PAGES = `#graphql\nquery RepairPages($after: String) { pages(first: 25, after: $after) { nodes { ${PAGE_FIELDS} } pageInfo { hasNextPage endCursor } } }`;
const PAGE = `#graphql\nquery RepairPage($id: ID!) { page(id: $id) { ${PAGE_FIELDS} } }`;
const PRODUCT = `#graphql\nquery RepairProduct($handle: String!) { productByHandle(handle: $handle) { id handle } }`;
const UPDATE = `#graphql\nmutation RepairPageUpdate($id: ID!, $page: PageUpdateInput!) { pageUpdate(id: $id, page: $page) { page { id } userErrors { field message } } }`;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const metaKey = (shop, id) => `${repairPrefix(shop, id)}/job.json`;
const addLog = (job, level, message) => { job.logs.push({ time: new Date().toISOString(), level, message }); job.logs = job.logs.slice(-150); };

export async function repairGraphql(admin, query, variables, job, assertOwner = () => {}, sleep = wait) {
  // Cost metadata drives pacing between calls; retries are bounded and logged.
  for (let attempt = 0; attempt < 5; attempt++) {
    assertOwner();
    const nextDelay = Math.min(10000, Math.max(0, (job.nextRequestAt || 0) - Date.now()));
    if (nextDelay) { addLog(job, "throttle", `Waiting ${nextDelay} ms for Shopify capacity.`); await sleep(nextDelay); }
    job.requestCount++;
    let json; let status; let retry = false; let retryAfter = 0;
    try {
      const response = await admin.graphql(query, { variables }); status = response.status;
      retryAfter = Number(response.headers?.get?.("retry-after") || 0) * 1000;
      if (status === 429 || status >= 500) retry = true;
      else json = await response.json();
    } catch (error) {
      const body = error.body;
      const errors = Array.isArray(body?.errors) ? body.errors : body?.errors?.graphQLErrors;
      if (errors?.length) json = { ...body, errors };
      else if ([429, 500, 502, 503, 504].includes(error.response?.code || error.response?.status) || ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"].includes(error.code || error.cause?.code) || /fetch failed|socket hang up/i.test(error.message)) retry = true;
      else throw error;
    }
    const cost = json?.extensions?.cost; const capacity = cost?.throttleStatus;
    if (capacity?.restoreRate > 0) {
      const budget = Math.max(25, Number(cost.requestedQueryCost || 0));
      job.nextRequestAt = Date.now() + Math.ceil(Math.max(0, budget - capacity.currentlyAvailable) / capacity.restoreRate * 1000);
    }
    if (json?.errors?.length) {
      retry = json.errors.every((error) => ["THROTTLED", "INTERNAL_SERVER_ERROR"].includes(error.extensions?.code));
      if (!retry) throw new Error(json.errors.map((error) => error.message).join("; "));
    }
    if (retry) {
      if (attempt === 4) throw new Error(`Shopify request failed after five attempts: ${json?.errors?.map((e) => e.message).join("; ") || status || "network error"}.`);
      const delay = Math.min(10000, Math.max(retryAfter, 1000 * 2 ** attempt, (job.nextRequestAt || 0) - Date.now()));
      addLog(job, "throttle", `Shopify ${status === 429 || json?.errors?.some((e) => e.extensions?.code === "THROTTLED") ? "throttled" : "temporary failure"}; retry ${attempt + 1}/4 in ${delay} ms.`);
      await sleep(delay); continue;
    }
    if (!json?.data) throw new Error("Shopify did not return data.");
    return json.data;
  }
}

async function withLock(key, work) {
  const previous = await readRepairJson(key);
  if (previous?.value.until > Date.now()) throw new Error("A batch is already running. Wait briefly, then refresh.");
  const owner = randomUUID(); let etag = await writeRepairJson(key, { owner, until: Date.now() + 180000 }, previous ? { IfMatch: previous.etag } : { IfNoneMatch: "*" });
  let lost = false; let tail = Promise.resolve();
  function assertOwner() { if (lost) throw new Error("Batch ownership changed. Refresh and resume."); }
  function renew(release = false) {
    const work = tail.then(async () => {
      assertOwner();
      try { etag = await writeRepairJson(key, { owner, until: release ? 0 : Date.now() + 180000 }, { IfMatch: etag }); }
      catch (error) { lost = true; throw error; }
    });
    tail = work.catch(() => {}); return work;
  }
  const timer = setInterval(() => { renew().catch(() => {}); }, 20000); timer.unref?.();
  try { return await work(assertOwner); }
  finally { clearInterval(timer); await tail; if (!lost) await renew(true).catch(() => {}); }
}
export async function getRepairJob(shop, id) {
  const entry = await readRepairJson(metaKey(shop, id));
  if (entry && (entry.value.shop !== shop || entry.value.id !== id)) throw new Error("Repair job ownership mismatch.");
  return entry?.value || null;
}
export async function latestRepairJob(shop) {
  const index = await readRepairJson(`${repairPrefix(shop)}/latest.json`);
  return index ? getRepairJob(shop, index.value.id) : null;
}
export async function createRepairJob(shop) {
  return withLock(`${repairPrefix(shop)}/create-lock.json`, async () => {
    const current = await latestRepairJob(shop);
    if (current && !["done"].includes(current.phase)) return current;
    const job = {
      id: randomUUID(), shop, token: randomBytes(32).toString("hex"), workflowVersion: 2, phase: "pages", status: "paused", error: "",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), scanComplete: false, endedEarly: false,
      productCursor: null, pageCursor: null, seenProductCursors: [], seenPageCursors: [],
      productsScanned: 0, pagesScanned: 0, ymmtPages: 0, completePages: 0, affectedPages: 0, repairablePages: 0,
      requestCount: 0, catalogKey: null, batches: [], results: {}, fixBatch: 0, fixRow: 0, logs: [],
    };
    addLog(job, "info", "Ready to scan pages. No product catalog scan or Shopify changes have started.");
    await writeRepairJson(metaKey(shop, job.id), job, { IfNoneMatch: "*" });
    await writeRepairJson(`${repairPrefix(shop)}/latest.json`, { id: job.id }); return job;
  });
}
function connection(value, label) {
  if (!Array.isArray(value?.nodes) || !value?.pageInfo) throw new Error(`Shopify returned an incomplete ${label} batch.`);
  if (value.pageInfo.hasNextPage && !value.pageInfo.endCursor) throw new Error(`Shopify omitted the next ${label} cursor.`);
  return value;
}
function nextCursor(job, connection, kind) {
  if (!connection.pageInfo.hasNextPage) return false;
  const cursor = connection.pageInfo.endCursor;
  const seen = kind === "product" ? job.seenProductCursors : job.seenPageCursors;
  if (seen.includes(cursor)) throw new Error(`Shopify repeated a ${kind} cursor.`);
  seen.push(cursor); job[`${kind}Cursor`] = cursor; return true;
}
const countResults = (rows) => {
  const counts = { corrected: 0, partial: 0, unchanged: 0, unresolved: 0, failed: 0, changed: 0 };
  for (const result of Object.values(rows)) counts[result.status]++;
  return counts;
};
export function repairCounts(job) {
  const counts = { corrected: 0, partial: 0, unchanged: 0, unresolved: 0, failed: 0, changed: 0 };
  for (const result of Object.values(job.results)) for (const key of Object.keys(counts)) counts[key] += result.counts[key] || 0;
  return counts;
}

function valueFor(page, field) {
  return field === "page.body" ? page.body || "" : field === "ymmt.vehicle" ? page.vehicle?.value : field === "ymmt.product_handle" ? page.productHandle?.value : page.sourceProductHandle?.value;
}
function bodyMatches(actual, expected) {
  if (actual === expected) return true;
  const vehicleId = (body) => {
    const match = String(body || "").match(/\b(?:var|let|const)\s+VEHICLE_ID\s*=\s*("(?:[^"\\]|\\.)*")/);
    try { return match ? JSON.parse(match[1]) : null; } catch { return null; }
  };
  if (vehicleId(expected) !== null && vehicleId(actual) !== vehicleId(expected)) return false;
  const wanted = embeddedRecords(expected); const records = embeddedRecords(actual || "");
  return wanted.length > 0 && wanted.every((block) => records.some((candidate) => candidate.name === block.name && JSON.stringify(candidate.value) === JSON.stringify(block.value)));
}
function changeMatches(page, change) {
  const actual = valueFor(page, change.field);
  return change.field === "page.body" ? bodyMatches(actual, change.value) : actual === change.value;
}
async function repairOne(admin, row, products, job, assertOwner) {
  const data = await repairGraphql(admin, PAGE, { id: row.id }, job, assertOwner);
  const page = data.page;
  if (!page) return { status: "changed", message: "Page was deleted after the scan.", fields: [] };
  const fresh = analysePage(page, products, job.shop);
  if (!fresh.issues.length) return { status: "unchanged", message: "Already complete when checked before correction.", fields: [] };
  if (pageFingerprint(page) !== row.fingerprint) {
    if (row.changes.length && row.changes.every((change) => changeMatches(page, change))) return { status: "partial", message: "Planned corrections are already present and verified; remaining issues still need review.", fields: row.changes.map((change) => change.field) };
    return { status: "changed", message: "Page changed after the scan. Run a new scan to review its current values.", fields: [] };
  }
  if (!row.changes.length) return { status: "unresolved", message: row.unresolved.join(" ") || "No verified correction available.", fields: [] };
  for (const handle of [...new Set(row.changes.filter((change) => /product_handle$/.test(change.field)).map((change) => change.value))]) {
    const check = await repairGraphql(admin, PRODUCT, { handle }, job, assertOwner);
    if (!check.productByHandle || (Array.isArray(products) && check.productByHandle.id !== products.find((p) => p.handle === handle)?.id)) return { status: "changed", message: `Product ${handle} changed or was removed. Run a new scan.`, fields: [] };
  }
  // Save a complete before-image before sending a mutation. This backup survives
  // retries and can be used for recovery; no automatic rollback overwrites edits.
  const backupKey = `${repairPrefix(job.shop, job.id)}/backups/${page.id.split("/").pop()}.json`;
  const existing = await readRepairJson(backupKey);
  if (!existing) await writeRepairJson(backupKey, page, { IfNoneMatch: "*" });
  const input = {}; const metafields = [];
  for (const change of row.changes) {
    if (change.field === "page.body") input.body = change.value;
    else {
      const key = change.field.split(".")[1];
      const meta = key === "vehicle" ? page.vehicle : key === "product_handle" ? page.productHandle : page.sourceProductHandle;
      metafields.push(meta?.id ? { id: meta.id, value: change.value } : { namespace: "ymmt", key, type: change.type, value: change.value });
    }
  }
  if (metafields.length) input.metafields = metafields;
  assertOwner();
  const updated = await repairGraphql(admin, UPDATE, { id: page.id, page: input }, job, assertOwner);
  const errors = updated.pageUpdate?.userErrors;
  if (errors?.length) throw new Error(errors.map((e) => `${e.field?.join(".") || "page"}: ${e.message}`).join("; "));
  if (!updated.pageUpdate?.page?.id) throw new Error("Shopify did not confirm the page update.");
  const verification = await repairGraphql(admin, PAGE, { id: page.id }, job, assertOwner);
  if (!verification.page) throw new Error("The updated page could not be verified.");
  for (const change of row.changes) {
    if (!changeMatches(verification.page, change)) throw new Error(`Shopify verification failed for ${change.field}.`);
  }
  const remaining = analysePage(verification.page, products, job.shop);
  return { status: remaining.issues.length ? "partial" : "corrected", message: remaining.issues.length ? `Verified fields updated; review remaining issues: ${remaining.issues.join(", ")}.` : "All audited missing values corrected and verified.", fields: row.changes.map((change) => change.field) };
}

export async function advanceRepairJob(shop, id, admin, intent = "advance") {
  const prefix = repairPrefix(shop, id);
  return withLock(`${prefix}/batch-lock.json`, async (assertOwner) => {
    const entry = await readRepairJson(metaKey(shop, id));
    if (!entry || entry.value.shop !== shop) throw new Error("Repair job not found.");
    let job = entry.value; let etag = entry.etag;
    let committed = structuredClone(job);
    async function save() {
      assertOwner(); job.updatedAt = new Date().toISOString(); job.status = "paused"; job.error = "";
      etag = await writeRepairJson(metaKey(shop, id), job, { IfMatch: etag }); committed = structuredClone(job);
    }
    try {
      if (intent === "correct") {
        if (job.phase !== "review") throw new Error("Finish scanning and review the report first.");
        job.phase = "correcting"; addLog(job, "info", "Applying verified corrections. Before-images are saved in R2."); await save(); return job;
      }
      if (intent === "retry-failed") {
        if (job.phase !== "results") throw new Error("Finish the correction pass before retrying failed pages.");
        job.phase = "correcting"; job.retryFailures = true; job.fixBatch = 0; job.fixRow = 0;
        addLog(job, "info", "Retrying failed page corrections; completed results are retained."); await save(); return job;
      }
      if (intent === "finalize") {
        if (!["results", "review"].includes(job.phase) && job.status !== "failed") throw new Error("Finish the current scan or correction pass first.");
        job.endedEarly = !["results", "review"].includes(job.phase);
        job.phase = "done"; addLog(job, "info", job.endedEarly ? "Session ended before completion. Retained reports are partial; start a new scan if needed." : "Session finalized. CSV reports remain available."); await save(); return job;
      }
      if (intent !== "advance") throw new Error("Unknown repair action.");
      // New page-only sessions do not read or scan a product catalog.
      if (["products", "products_done"].includes(job.phase)) {
        job.phase = "pages"; job.workflowVersion = 2;
        addLog(job, "info", "Old product-scan step skipped. Scanning pages directly.");
        await save(); return job;
      }
      const catalog = job.workflowVersion === 2 ? null : job.catalogKey ? (await readRepairJson(job.catalogKey))?.value : [];
      if (job.workflowVersion !== 2 && !Array.isArray(catalog)) throw new Error("The saved product catalog is missing. End this session and start a new scan.");
      if (job.phase === "pages") {
        const data = await repairGraphql(admin, PAGES, { after: job.pageCursor }, job, assertOwner);
        const batch = connection(data.pages, "pages"); const rows = [];
        for (const page of batch.nodes) {
          job.pagesScanned++;
          if (!isYMMTPage(page)) continue;
          job.ymmtPages++; const row = analysePage(page, job.workflowVersion === 2 ? null : catalog, shop);
          if (!row.issues.length) job.completePages++;
          else { rows.push(row); job.affectedPages++; if (row.repairable) job.repairablePages++; }
        }
        if (rows.length) {
          const key = await uniqueRepairJson(`${prefix}/rows`, rows);
          job.batches.push({ key, count: rows.length });
        }
        if (!nextCursor(job, batch, "page")) { job.phase = "review"; job.scanComplete = true; }
        addLog(job, "success", `Checked ${job.pagesScanned} pages; ${job.ymmtPages} YMMT, ${job.completePages} complete, ${job.affectedPages} affected. ${job.phase === "review" ? "Review and CSV export ready." : "Checkpoint saved."}`);
        await save();
      } else if (job.phase === "correcting") {
        const descriptor = job.batches[job.fixBatch];
        if (!descriptor) { job.phase = "results"; addLog(job, "success", "Correction pass complete. Review final results and unresolved pages."); await save(); return job; }
        const rows = (await readRepairJson(descriptor.key))?.value;
        if (!Array.isArray(rows)) throw new Error("An audit batch is missing.");
        const previous = job.results[job.fixBatch];
        let receipts = previous ? (await readRepairJson(previous.key))?.value : {};
        if (!receipts || typeof receipts !== "object") throw new Error("Saved correction results are missing.");
        // Limit each HTTP request to five pages; save after every page.
        for (let limit = 0; limit < 5 && job.fixRow < rows.length; limit++) {
          const row = rows[job.fixRow]; const old = receipts[row.id];
          if (!old || (job.retryFailures && old.status === "failed")) {
            let result;
            try { result = await repairOne(admin, row, catalog, job, assertOwner); }
            catch (error) { result = { status: "failed", message: repairError(error), fields: [] }; }
            receipts = { ...receipts, [row.id]: { ...result, time: new Date().toISOString() } };
            addLog(job, result.status === "failed" ? "error" : "info", `${row.handle}: ${result.status}. ${result.message}`);
          }
          const oldKey = job.results[job.fixBatch]?.key;
          const resultKey = await uniqueRepairJson(`${prefix}/results`, receipts);
          job.results[job.fixBatch] = { key: resultKey, counts: countResults(receipts) };
          job.fixRow++;
          await save(); await removeRepairObject(oldKey);
        }
        if (job.fixRow >= rows.length) { job.fixBatch++; job.fixRow = 0; }
        if (job.fixBatch >= job.batches.length) { job.phase = "results"; job.retryFailures = false; addLog(job, "success", "Correction pass complete. Final results are ready."); }
        await save();
      }
      return job;
    } catch (error) {
      // Reload the most recent committed checkpoint, not partially scanned data.
      job = structuredClone(committed); job.status = "failed"; job.error = repairError(error);
      addLog(job, "error", job.error); job.updatedAt = new Date().toISOString();
      assertOwner(); await writeRepairJson(metaKey(shop, id), job, { IfMatch: etag });
      return job;
    }
  });
}

async function savedResults(job, index) {
  if (!job.results[index]) return {};
  const value = (await readRepairJson(job.results[index].key))?.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A saved result batch is missing. Its report cannot be verified.");
  return value;
}
export async function repairView(job, origin, offset = 0) {
  if (!job) return null;
  const rows = []; let skipped = 0;
  offset = Math.max(0, Math.floor(Number(offset) || 0));
  for (let i = 0; i < job.batches.length; i++) {
    const batch = job.batches[i];
    if (skipped + batch.count <= offset) { skipped += batch.count; continue; }
    const data = (await readRepairJson(batch.key))?.value;
    if (!Array.isArray(data)) throw new Error("An audit batch is missing.");
    const results = await savedResults(job, i);
    for (const row of data) {
      if (skipped++ < offset) continue;
      rows.push({ id: row.id, handle: row.handle, url: row.url, adminUrl: row.adminUrl, issues: row.issues, unresolved: row.unresolved, proposedProduct: row.proposedProduct, fields: row.changes.map((c) => c.field), result: results[row.id] || null });
      if (rows.length === 25) break;
    }
    if (rows.length === 25) break;
  }
  const url = new URL("/ymmt-repair.csv", origin);
  url.searchParams.set("shop", job.shop); url.searchParams.set("job", job.id); url.searchParams.set("token", job.token);
  return {
    id: job.id, phase: job.phase, status: job.status, error: job.error, updatedAt: job.updatedAt, scanComplete: job.scanComplete, endedEarly: job.endedEarly,
    workflowVersion: job.workflowVersion || 1, pagesScanned: job.pagesScanned, ymmtPages: job.ymmtPages,
    completePages: job.completePages, affectedPages: job.affectedPages, repairablePages: job.repairablePages,
    requestCount: job.requestCount, logs: job.logs, counts: repairCounts(job), rows, offset,
    repairProcessed: Object.values(repairCounts(job)).reduce((sum, count) => sum + count, 0),
    reportUrl: ["review", "correcting", "results", "done"].includes(job.phase) ? url.toString() : null,
  };
}
function csv(value) {
  let text = String(value ?? ""); if (/^[=+@-]/.test(text.trimStart())) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}
export async function downloadRepairCsv(request) {
  const url = new URL(request.url); const shop = url.searchParams.get("shop") || ""; const id = url.searchParams.get("job") || "";
  let job;
  try { job = await getRepairJob(shop, id); } catch { return new Response("Report not found.", { status: 404 }); }
  const token = url.searchParams.get("token") || "";
  if (!job || !/^[0-9a-f]{64}$/.test(token) || !/^[0-9a-f]{64}$/.test(job.token || "") || !timingSafeEqual(Buffer.from(token, "hex"), Buffer.from(job.token, "hex"))) return new Response("Report not found.", { status: 404 });
  if (!["review", "correcting", "results", "done"].includes(job.phase)) return new Response("Finish the page scan before exporting.", { status: 409 });
  const columns = ["audit_status", "page_id", "title", "handle", "page_url", "admin_url", "missing_or_invalid_fields", "current_product_handle", "current_source_product_handle", "current_vehicle_json", "proposed_product_handle", "proposed_fields", "proposed_values_json", "evidence", "unresolved_issues", "result", "result_message", "updated_fields", "result_time", "product_validation"];
  async function* lines() {
    yield "\uFEFF" + columns.map(csv).join(",") + "\r\n";
    for (let i = 0; i < job.batches.length; i++) {
      const rows = (await readRepairJson(job.batches[i].key))?.value;
      if (!Array.isArray(rows)) throw new Error("A report batch is missing.");
      const results = await savedResults(job, i);
      for (const row of rows) {
        const result = results[row.id];
        const proposed = Object.fromEntries(row.changes.map((change) => [change.field, change.field === "page.body" ? "Repair existing embedded JSON or rebuild empty body" : change.value]));
        yield [job.scanComplete ? "complete scan" : "incomplete scan", row.id, row.title, row.handle, row.url, row.adminUrl, row.issues.join("; "), row.current.productHandle, row.current.sourceProductHandle, row.current.vehicle, row.proposedProduct, row.changes.map((c) => c.field).join("; "), JSON.stringify(proposed), row.evidence.join("; "), row.unresolved.join("; "), result?.status || "pending", result?.message || "", result?.fields.join("; ") || "", result?.time || "", row.productValidation || "Catalog scanned"].map(csv).join(",") + "\r\n";
      }
    }
  }
  return new Response(request.method === "HEAD" ? null : Readable.toWeb(Readable.from((async function* () { for await (const line of lines()) yield Buffer.from(line, "utf8"); })())), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="ymmt-page-audit-${id}.csv"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
}
