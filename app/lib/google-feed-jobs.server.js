import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import sax from "sax";
import {
  FEED_FOOTER, feedHeader, getPageBatch, graphqlWithRetry,
  linkedProduct, pageYear, renderItem,
} from "./google-feed-data.server";

// Persist both file bytes and checkpoints on the SAME Railway volume.
// Deploy one Node application process/replica for this volume-backed worker.
const running = new Map();
const LOCK_TIMEOUT = 120000;
const ACTIVE_STATUSES = new Set(["queued", "building", "validating", "compressing"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function feedStorageRoot() {
  const root = process.env.GOOGLE_FEED_EXPORT_DIR ||
    (process.env.RAILWAY_VOLUME_MOUNT_PATH ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "ymmt-feeds") : "");
  if (!root || !path.isAbsolute(root)) {
    throw new Error("Attach a persistent Railway volume at /data and set GOOGLE_FEED_EXPORT_DIR=/data/ymmt-feeds before creating exports.");
  }
  return root;
}

function shopDirectory(shop) {
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) throw new Error("Invalid shop.");
  return path.join(feedStorageRoot(), createHash("sha256").update(shop).digest("hex"));
}
function jobPaths(shop, id) {
  if (!UUID.test(id)) throw new Error("Invalid export ID.");
  const directory = path.join(shopDirectory(shop), id);
  return { directory, state: path.join(directory, "job.json"), xml: path.join(directory, "feed.xml"), gzip: path.join(directory, "feed.xml.gz") };
}

async function readJson(filename) {
  try { return JSON.parse(await readFile(filename, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function atomicJson(filename, value) {
  const temp = `${filename}.${randomUUID()}.tmp`;
  const file = await open(temp, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
  finally { await file.close(); }
  await rename(temp, filename);
}
async function saveJob(job) {
  job.updatedAt = new Date().toISOString();
  await atomicJson(jobPaths(job.shop, job.id).state, job);
}

// A heartbeat lock protects a checkpoint from a duplicate worker. Stale locks
// are reclaimed after two minutes, allowing recovery after a stopped process.
async function acquireLock(directory) {
  const token = randomUUID();
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const current = await readJson(path.join(directory, "owner.json"));
    const timestamp = current?.heartbeat || (await stat(directory)).mtimeMs;
    if (Date.now() - timestamp < LOCK_TIMEOUT) return null;
    // Rename the stale directory atomically before acquiring a new lock.
    const stale = `${directory}.stale.${token}`;
    try { await rename(directory, stale); }
    catch (moveError) { if (["ENOENT", "EEXIST"].includes(moveError.code)) return null; throw moveError; }
    await rm(stale, { recursive: true, force: true });
    return acquireLock(directory);
  }
  await atomicJson(path.join(directory, "owner.json"), { token, heartbeat: Date.now() });
  let lost = false;
  let heartbeatRunning = false;
  async function assertOwner() {
    const current = await readJson(path.join(directory, "owner.json"));
    if (lost || current?.token !== token) throw new Error("Export worker lock was lost. Retry the export to resume.");
  }
  const timer = setInterval(async () => {
    if (heartbeatRunning) return;
    heartbeatRunning = true;
    try { await assertOwner(); await atomicJson(path.join(directory, "owner.json"), { token, heartbeat: Date.now() }); }
    catch { lost = true; }
    finally { heartbeatRunning = false; }
  }, 20000);
  timer.unref?.();
  return {
    assertOwner,
    async release() {
      clearInterval(timer);
      const current = await readJson(path.join(directory, "owner.json"));
      if (current?.token === token) await rm(directory, { recursive: true, force: true });
    },
  };
}

export async function getFeedJob(shop, id) {
  const job = await readJson(jobPaths(shop, id).state);
  if (job && (job.shop !== shop || job.id !== id)) throw new Error("Export ownership mismatch.");
  return job;
}
export async function getLatestFeedJob(shop) {
  const index = await readJson(path.join(shopDirectory(shop), "latest.json"));
  return index ? getFeedJob(shop, index.id) : null;
}

export async function createFeedJob(shop, year) {
  if (year && !/^\d{4}$/.test(year)) throw new Error("Select a valid year or All years.");
  const directory = shopDirectory(shop);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = await acquireLock(path.join(directory, "create.lock"));
  if (!lock) throw new Error("Another export request is being prepared. Try again shortly.");
  try {
    const current = await getLatestFeedJob(shop);
    if (current && ACTIVE_STATUSES.has(current.status)) return current;
    const job = {
      id: randomUUID(), shop, year, token: randomBytes(32).toString("hex"),
      status: "queued", error: "", createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), cursor: null, completedInBatch: [],
      seenCursors: [], started: false, footerWritten: false,
      pagesChecked: 0, pagesIncluded: 0, offers: 0, bytes: 0,
      gzipBytes: 0, currency: "", attempts: 0,
    };
    await mkdir(jobPaths(shop, job.id).directory, { recursive: true, mode: 0o700 });
    await saveJob(job);
    await atomicJson(path.join(directory, "latest.json"), { id: job.id });
    return job;
  } finally { await lock.release(); }
}

async function appendCheckpoint(file, job, text, lock) {
  await lock.assertOwner();
  const buffer = Buffer.from(text, "utf8");
  let written = 0;
  while (written < buffer.length) {
    const result = await file.write(buffer, written, buffer.length - written, job.bytes + written);
    if (!result.bytesWritten) throw new Error("The export file could not be written.");
    written += result.bytesWritten;
  }
  await file.sync();
  job.bytes += buffer.length;
}

async function validateXml(filename, expectedOffers) {
  const parser = sax.parser(true, { xmlns: true });
  let count = 0;
  let root = "";
  parser.onopentag = (node) => {
    if (!root) root = node.name;
    if (node.name === "item") count++;
  };
  const stream = createReadStream(filename, { encoding: "utf8" });
  try { for await (const text of stream) parser.write(text); parser.close(); }
  finally { stream.destroy(); }
  if (root !== "rss" || count !== expectedOffers) throw new Error("The completed XML failed its offer-count validation.");
}

async function runJob(shop, id, admin, retry) {
  const files = jobPaths(shop, id);
  const lock = await acquireLock(path.join(files.directory, "worker.lock"));
  if (!lock) return;
  let job;
  let file;
  try {
    job = await getFeedJob(shop, id);
    if (!job || job.status === "ready" || (job.status === "failed" && !retry)) return;
    job.status = job.footerWritten ? "validating" : "building";
    job.error = "";
    job.attempts++;
    await saveJob(job);
    if (!job.currency) {
      const data = await graphqlWithRetry(admin, `#graphql\nquery FeedShop { shop { currencyCode } }`);
      job.currency = data.shop?.currencyCode || "";
      if (!job.currency) throw new Error("Shopify did not return the store currency.");
      await saveJob(job);
    }
    if (!job.footerWritten) {
      // Discard only uncommitted trailing bytes left by an interrupted write.
      try { file = await open(files.xml, "r+"); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        if (job.bytes) throw new Error("The checkpoint file is missing. Create a new export.");
        file = await open(files.xml, "w+", 0o600);
      }
      const details = await file.stat();
      if (details.size < job.bytes) throw new Error("The checkpoint file is shorter than expected. Create a new export.");
      await file.truncate(job.bytes);
      if (!job.started) {
        await appendCheckpoint(file, job, feedHeader(shop), lock);
        job.started = true;
        await saveJob(job);
      }
      const cache = new Map();
      // The worker owns its signal; closing a browser tab does not abort it.
      const signal = new AbortController().signal;
      while (true) {
        await lock.assertOwner();
        const connection = await getPageBatch(admin, job.cursor, job.year);
        const completed = new Set(job.completedInBatch);
        for (const page of connection.nodes) {
          if (completed.has(page.id)) continue;
          const include = page.templateSuffix === "product-ymmt" && page.isPublished && (!job.year || pageYear(page) === job.year);
          if (include) {
            const product = await linkedProduct(admin, page, cache, signal);
            if (!product.variants.length) throw new Error(`Product ${product.handle} has no variants.`);
            const xml = product.variants.map((variant) => renderItem(page, product, variant, `https://${shop}`, job.currency)).join("");
            await appendCheckpoint(file, job, xml, lock);
            job.pagesIncluded++;
            job.offers += product.variants.length;
          }
          job.pagesChecked++;
          job.completedInBatch.push(page.id);
          completed.add(page.id);
          await lock.assertOwner();
          await saveJob(job);
        }
        if (!connection.pageInfo.hasNextPage) break;
        const cursor = connection.pageInfo.endCursor;
        if (job.seenCursors.includes(cursor)) throw new Error("Shopify repeated a page cursor. Create a new export.");
        job.seenCursors.push(cursor);
        job.cursor = cursor;
        job.completedInBatch = [];
        await lock.assertOwner();
        await saveJob(job);
      }
      await appendCheckpoint(file, job, FEED_FOOTER, lock);
      job.footerWritten = true;
      job.status = "validating";
      await saveJob(job);
      await file.close(); file = null;
    }
    await validateXml(files.xml, job.offers);
    await lock.assertOwner();
    job.status = "compressing";
    await saveJob(job);
    const gzipTemp = `${files.gzip}.tmp`;
    await pipeline(createReadStream(files.xml), createGzip({ level: 6 }), createWriteStream(gzipTemp, { mode: 0o600 }));
    const gzipFile = await open(gzipTemp, "r+");
    try { await gzipFile.sync(); } finally { await gzipFile.close(); }
    await lock.assertOwner();
    await rename(gzipTemp, files.gzip);
    job.gzipBytes = (await stat(files.gzip)).size;
    job.status = "ready";
    job.completedAt = new Date().toISOString();
    await saveJob(job);
  } catch (error) {
    console.error("Google feed export job error:", { shop, id, error });
    if (job) {
      // Reload the last committed checkpoint; an append may not have committed.
      try {
        await lock.assertOwner();
        const committed = await getFeedJob(shop, id);
        committed.status = "failed";
        committed.error = error.code === "ENOSPC"
          ? "The export volume is full. Increase its storage capacity, then retry."
          : String(error.message || "Export failed.").slice(0, 1000);
        await saveJob(committed);
      } catch (saveError) { console.error("Unable to save feed failure:", saveError); }
    }
  } finally {
    if (file) await file.close();
    await lock.release();
  }
}

export async function queueFeedRetry(shop, id) {
  const job = await getFeedJob(shop, id);
  if (!job) throw new Error("Export not found.");
  if (job.status === "failed") {
    const latest = await getLatestFeedJob(shop);
    if (latest && latest.id !== id && ACTIVE_STATUSES.has(latest.status)) {
      throw new Error("Another export is already in progress. Wait for it to finish.");
    }
    job.status = "queued";
    job.error = "";
    await saveJob(job);
  }
  return job;
}

export function startFeedJob(shop, id, admin, { retry = false } = {}) {
  const key = `${shop}:${id}`;
  if (running.has(key)) return running.get(key);
  const work = runJob(shop, id, admin, retry).catch((error) => {
    console.error("Google feed worker error:", { shop, id, error });
  }).finally(() => running.delete(key));
  running.set(key, work);
  return work;
}

export function feedJobView(job, origin) {
  if (!job) return null;
  const result = {
    id: job.id, year: job.year, status: job.status, error: job.error,
    pagesChecked: job.pagesChecked, pagesIncluded: job.pagesIncluded,
    offers: job.offers, bytes: job.bytes, gzipBytes: job.gzipBytes,
    createdAt: job.createdAt, updatedAt: job.updatedAt,
  };
  if (job.status === "ready") {
    const url = new URL("/google-feed.xml", origin);
    url.searchParams.set("shop", job.shop);
    url.searchParams.set("job", job.id);
    url.searchParams.set("token", job.token);
    result.xmlUrl = url.toString();
    url.searchParams.set("format", "gzip");
    result.gzipUrl = url.toString();
  }
  return result;
}

function validToken(token, expected) {
  if (!/^[0-9a-f]{64}$/.test(token || "") || !/^[0-9a-f]{64}$/.test(expected || "")) return false;
  return timingSafeEqual(Buffer.from(token, "hex"), Buffer.from(expected, "hex"));
}

export function parseRange(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value || "");
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  let start; let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return null;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

export async function downloadFeed(request) {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") || "";
  const id = url.searchParams.get("job") || "";
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) || !UUID.test(id)) {
    return new Response("Create an export from the Google Feed page first.", { status: 400 });
  }
  const job = await getFeedJob(shop, id);
  if (!job || !validToken(url.searchParams.get("token"), job.token)) return new Response("Download not found.", { status: 404 });
  if (job.status !== "ready") return new Response("This export is not ready to download.", { status: 409 });
  const compressed = url.searchParams.get("format") === "gzip";
  const files = jobPaths(shop, id);
  const filename = compressed ? files.gzip : files.xml;
  const size = (await stat(filename)).size;
  const etag = `"${id}-${compressed ? "gzip" : "xml"}-${size}"`;
  const headers = {
    "Content-Type": compressed ? "application/gzip" : "application/xml; charset=utf-8",
    "Content-Disposition": `attachment; filename="google-feed-${job.year || "all-years"}-${id}${compressed ? ".xml.gz" : ".xml"}"`,
    "Cache-Control": "private, no-store", "Accept-Ranges": "bytes", "ETag": etag,
    "Content-Length": String(size), "X-Content-Type-Options": "nosniff",
  };
  let options = {}; let status = 200;
  const rangeHeader = request.headers.get("range");
  const ifRange = request.headers.get("if-range");
  if (rangeHeader && (!ifRange || ifRange === etag)) {
    const range = parseRange(rangeHeader, size);
    if (!range) return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}`, "Content-Length": "0" } });
    options = range; status = 206;
    headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;
    headers["Content-Length"] = String(range.end - range.start + 1);
  }
  const body = request.method === "HEAD" ? null : Readable.toWeb(createReadStream(filename, options));
  return new Response(body, { status, headers });
}
