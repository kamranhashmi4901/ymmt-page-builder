import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { analysePage, isYMMTPage } from "./ymmt-page-repair-analysis.server";
import { repairPrefix, readRepairJson, writeRepairJson, uniqueRepairJson, removeRepairObject, repairError } from "./ymmt-page-repair-storage.server";
const scanPrefix = (shop, id = "") => repairPrefix(shop, id).replace(/^ymmt-repairs\//, "ymmt-scans/");
const PAGE_FIELDS = `id title handle body templateSuffix isPublished
  vehicle: metafield(namespace: "ymmt", key: "vehicle") { id type value }
  productHandle: metafield(namespace: "ymmt", key: "product_handle") { id type value }
  sourceProductHandle: metafield(namespace: "ymmt", key: "source_product_handle") { id type value }`;
const PAGES = `#graphql
query ScanYMMTPages($after: String) { pages(first: 25, after: $after) { nodes { ${PAGE_FIELDS} } pageInfo { hasNextPage endCursor } } }`;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const metaKey = (shop, id) => `${scanPrefix(shop, id)}/job.json`;
const addLog = (job, level, message) => { job.logs.push({ time: new Date().toISOString(), level, message }); job.logs = job.logs.slice(-150); };

export async function scanGraphql(admin, query, variables, job, assertOwner = () => {}, sleep = wait) {
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

export async function withLock(key, work) {
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

export async function getScanJob(shop, id) {
  const entry = await readRepairJson(metaKey(shop, id));
  if (entry && (entry.value.shop !== shop || entry.value.id !== id)) throw new Error("Scan ownership mismatch.");
  return entry?.value || null;
}
export async function latestScanJob(shop) {
  const entry = await readRepairJson(`${scanPrefix(shop)}/latest.json`);
  return entry ? getScanJob(shop, entry.value.id) : null;
}
export async function createScanJob(shop) {
  return withLock(`${scanPrefix(shop)}/create-lock.json`, async () => {
    const current = await latestScanJob(shop);
    if (current && current.status !== "complete") return current;
    const job = {
      id: randomUUID(), shop, token: randomBytes(32).toString("hex"), status: "scanning", error: "",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      cursor: null, cursors: [], batches: [], logs: [], requestCount: 0,
      pagesScanned: 0, ymmtPages: 0, completePages: 0, affectedPages: 0,
      exportBatch: 0, exportStateKey: null, jsonKey: null, jsonVehicles: 0, jsonSkippedPages: 0, jsonConflictFields: 0,
    };
    addLog(job, "info", "Page scan created. No product scan or Shopify page updates will run.");
    await writeRepairJson(metaKey(shop, job.id), job, { IfNoneMatch: "*" });
    await writeRepairJson(`${scanPrefix(shop)}/latest.json`, { id: job.id });
    return job;
  });
}

// The sample supports either a direct model leaf or named trim leaves. A mixed
// trimmed/untrimmed model cannot represent both without inventing a trim name.
export function addSearchRecords(state, rows) {
  for (const row of rows) {
    const v = row.exportVehicle;
    if (!v?.year || !v.make || !v.model) { state.missingCoordinates++; continue; }
    const modelKey = JSON.stringify([v.year, v.make, v.model]);
    const key = JSON.stringify([v.year, v.make, v.model, v.trim || ""]);
    const group = state.models[modelKey] ||= { plainPages: 0, hasTrims: false };
    if (v.trim) group.hasTrims = true; else group.plainPages++;
    const entry = state.records[key] ||= { vehicle: { year: v.year, make: v.make, model: v.model, trim: v.trim || "" }, values: { Warning: [], Compatible: [], Manufacturer: [] } };
    for (const field of Object.keys(entry.values)) {
      const value = String(v[field] || "").trim();
      if (value && !entry.values[field].includes(value)) entry.values[field].push(value);
    }
  }
  return state;
}
export function buildSearchJson(state) {
  const data = Object.create(null); let vehicles = 0, conflicts = 0, mixedPages = 0;
  for (const model of Object.values(state.models)) if (model.hasTrims) mixedPages += model.plainPages;
  const entries = Object.values(state.records).sort((a, b) => JSON.stringify(a.vehicle).localeCompare(JSON.stringify(b.vehicle)));
  for (const entry of entries) {
    const v = entry.vehicle;
    if (!v.trim && state.models[JSON.stringify([v.year, v.make, v.model])].hasTrims) continue;
    const leaf = {};
    for (const [field, values] of Object.entries(entry.values)) {
      leaf[field] = values.length === 1 ? values[0] : "";
      if (values.length > 1) conflicts++;
    }
    const makes = data[v.year] ||= Object.create(null);
    const models = makes[v.make] ||= Object.create(null);
    if (v.trim) { const trims = models[v.model] ||= Object.create(null); trims[v.trim] = leaf; }
    else models[v.model] = leaf;
    vehicles++;
  }
  return { data, vehicles, conflicts, skippedPages: state.missingCoordinates + mixedPages };
}

export async function advanceScanJob(shop, id, admin) {
  const prefix = scanPrefix(shop, id);
  return withLock(`${prefix}/batch-lock.json`, async (assertOwner) => {
    const entry = await readRepairJson(metaKey(shop, id));
    if (!entry || entry.value.shop !== shop) throw new Error("Scan not found.");
    let job = entry.value, etag = entry.etag;
    if (job.status === "complete") return job;
    let committed = structuredClone(job);
    const save = async () => {
      assertOwner(); job.updatedAt = new Date().toISOString(); job.error = "";
      etag = await writeRepairJson(metaKey(shop, id), job, { IfMatch: etag });
      committed = structuredClone(job);
    };
    try {
      if (job.status === "failed") job.status = job.resumeStatus || "scanning";
      if (job.status === "scanning") {
        const data = await scanGraphql(admin, PAGES, { after: job.cursor }, job, assertOwner);
        const connection = data.pages;
        if (!Array.isArray(connection?.nodes) || !connection.pageInfo) throw new Error("Shopify returned an incomplete page batch.");
        if (connection.pageInfo.hasNextPage && (!connection.pageInfo.endCursor || job.cursors.includes(connection.pageInfo.endCursor))) throw new Error("Shopify returned a missing or repeated page cursor.");
        const rows = [];
        for (const page of connection.nodes) {
          job.pagesScanned++;
          if (!isYMMTPage(page)) continue;
          job.ymmtPages++;
          const analysis = analysePage(page, null, shop);
          if (!analysis.issues.length) { job.completePages++; continue; }
          job.affectedPages++;
          const { changes, fingerprint, repairable, ...row } = analysis;
          rows.push(row);
        }
        if (rows.length) job.batches.push({ key: await uniqueRepairJson(`${prefix}/rows`, rows), count: rows.length });
        if (connection.pageInfo.hasNextPage) {
          job.cursor = connection.pageInfo.endCursor; job.cursors.push(job.cursor);
        } else job.status = "preparing";
        addLog(job, "success", `Checked ${job.pagesScanned} pages · ${job.ymmtPages} YMMT · ${job.completePages} metadata complete · ${job.affectedPages} with issues.`);
        if (job.status === "preparing") addLog(job, "info", "Page scan complete. Preparing CSV and search-format JSON exports.");
        await save();
      } else if (job.status === "preparing") {
        let state = job.exportStateKey ? (await readRepairJson(job.exportStateKey))?.value : { records: {}, models: {}, missingCoordinates: 0 };
        if (!state) throw new Error("The JSON export checkpoint is missing.");
        for (let limit = 0; limit < 10 && job.exportBatch < job.batches.length; limit++, job.exportBatch++) {
          const rows = (await readRepairJson(job.batches[job.exportBatch].key))?.value;
          if (!Array.isArray(rows)) throw new Error("An audit batch is missing.");
          addSearchRecords(state, rows);
        }
        const oldKey = job.exportStateKey;
        job.exportStateKey = await uniqueRepairJson(`${prefix}/export-state`, state);
        if (job.exportBatch >= job.batches.length) {
          const result = buildSearchJson(state);
          job.jsonKey = await uniqueRepairJson(`${prefix}/exports`, result.data);
          job.jsonVehicles = result.vehicles; job.jsonSkippedPages = result.skippedPages; job.jsonConflictFields = result.conflicts;
          job.status = "complete";
          addLog(job, "success", `Scan complete. CSV: ${job.affectedPages} affected pages. JSON: ${job.jsonVehicles} unique vehicles.`);
          if (result.skippedPages) addLog(job, "warning", `${result.skippedPages} affected pages cannot be represented in the sample JSON structure (missing year/make/model or untrimmed records alongside named trims). They remain in CSV.`);
          if (result.conflicts) addLog(job, "warning", `${result.conflicts} conflicting JSON field values left blank. Original per-page values remain in CSV.`);
        } else addLog(job, "info", `JSON export prepared from ${job.exportBatch}/${job.batches.length} saved audit batches.`);
        await save(); await removeRepairObject(oldKey);
      } else throw new Error("Unknown scan status.");
      return job;
    } catch (error) {
      // Resume the last committed stage, not an unsaved transition to exports.
      const resumeStatus = committed.status === "failed" ? committed.resumeStatus : committed.status;
      job = structuredClone(committed); job.status = "failed"; job.resumeStatus = resumeStatus === "preparing" ? "preparing" : "scanning";
      job.error = repairError(error); job.updatedAt = new Date().toISOString(); addLog(job, "error", job.error);
      assertOwner(); await writeRepairJson(metaKey(shop, id), job, { IfMatch: etag });
      return job;
    }
  });
}

export async function scanView(job, origin, offset = 0) {
  if (!job) return null;
  offset = Math.max(0, Math.floor(Number(offset) || 0));
  const rows = []; let visited = 0;
  for (const batch of job.batches) {
    if (visited + batch.count <= offset) { visited += batch.count; continue; }
    const saved = (await readRepairJson(batch.key))?.value;
    if (!Array.isArray(saved)) throw new Error("An audit batch is missing.");
    for (const row of saved) {
      if (visited++ < offset) continue;
      rows.push({ id: row.id, title: row.title, handle: row.handle, url: row.url, adminUrl: row.adminUrl, issues: row.issues, unresolved: row.unresolved });
      if (rows.length >= 25) break;
    }
    if (rows.length >= 25) break;
  }
  const exportUrl = (format) => {
    const url = new URL(`/ymmt-scan.${format}`, origin);
    url.searchParams.set("shop", job.shop); url.searchParams.set("job", job.id); url.searchParams.set("token", job.token);
    return url.toString();
  };
  return { id: job.id, status: job.status, error: job.error, updatedAt: job.updatedAt, pagesScanned: job.pagesScanned, ymmtPages: job.ymmtPages, completePages: job.completePages, affectedPages: job.affectedPages, requestCount: job.requestCount, logs: job.logs, rows, offset, jsonVehicles: job.jsonVehicles, jsonSkippedPages: job.jsonSkippedPages, jsonConflictFields: job.jsonConflictFields, csvUrl: job.status === "complete" ? exportUrl("csv") : null, jsonUrl: job.status === "complete" ? exportUrl("json") : null };
}
const csvCell = (value) => {
  let text = String(value ?? ""); if (/^[=+@-]/.test(text.trimStart())) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
};
export async function downloadScanReport(request, format) {
  if (!["csv", "json"].includes(format)) return new Response("Not found.", { status: 404 });
  const url = new URL(request.url); let job;
  try { job = await getScanJob(url.searchParams.get("shop") || "", url.searchParams.get("job") || ""); }
  catch { return new Response("Report not found.", { status: 404 }); }
  const token = url.searchParams.get("token") || "";
  if (!job || !/^[0-9a-f]{64}$/.test(token) || !/^[0-9a-f]{64}$/.test(job.token || "") || !timingSafeEqual(Buffer.from(token, "hex"), Buffer.from(job.token, "hex"))) return new Response("Report not found.", { status: 404 });
  if (job.status !== "complete") return new Response("Finish the scan before exporting.", { status: 409 });
  const headers = { "Content-Type": format === "json" ? "application/json; charset=utf-8" : "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="ymmt-affected-pages-${job.id}.${format}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
  if (format === "json") {
    const saved = await readRepairJson(job.jsonKey);
    if (!saved) throw new Error("The saved JSON export is missing.");
    return new Response(request.method === "HEAD" ? null : JSON.stringify(saved.value, null, 2) + "\n", { headers });
  }
  async function* lines() {
    const columns = ["page_id", "title", "handle", "page_url", "admin_url", "missing_or_invalid_fields", "unresolved_issues", "year", "make", "model", "trim", "Warning", "Compatible", "Manufacturer", "current_product_handle", "current_source_product_handle", "current_vehicle_json", "product_validation"];
    yield Buffer.from("\uFEFF" + columns.map(csvCell).join(",") + "\r\n", "utf8");
    for (const batch of job.batches) {
      const rows = (await readRepairJson(batch.key))?.value;
      if (!Array.isArray(rows)) throw new Error("An audit batch is missing.");
      for (const row of rows) {
        const v = row.exportVehicle || {};
        yield Buffer.from([row.id, row.title, row.handle, row.url, row.adminUrl, row.issues.join("; "), row.unresolved.join("; "), v.year, v.make, v.model, v.trim, v.Warning, v.Compatible, v.Manufacturer, row.current.productHandle, row.current.sourceProductHandle, row.current.vehicle, row.productValidation].map(csvCell).join(",") + "\r\n", "utf8");
      }
    }
  }
  return new Response(request.method === "HEAD" ? null : Readable.toWeb(Readable.from(lines())), { headers });
}
