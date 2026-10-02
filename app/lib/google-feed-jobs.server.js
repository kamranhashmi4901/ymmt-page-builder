import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { StringDecoder } from "node:string_decoder";
import sax from "sax";
import {
  S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand,
  CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand, HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  FEED_FOOTER, feedHeader, getPageBatch, graphqlWithRetry,
  linkedProduct, pageYear, renderItem,
} from "./google-feed-data.server";

// No Railway volume: immutable XML chunks and checkpoints live in private R2.
// Checkpoints are committed at Shopify batch boundaries (normally 100 pages).
const PART_SIZE = 8 * 1024 * 1024;
const LEASE_MS = 180000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACTIVE = new Set(["queued", "building", "validating", "compressing"]);
const running = new Map();
let cached;

export function feedStorageRoot() {
  const names = ["R2_BUCKET_NAME", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"];
  const values = names.map((name) => process.env[name]?.trim());
  const missing = names.filter((_, index) => !values[index]);
  if (missing.length) throw new Error(`Add these Railway variables: ${missing.join(", ")}.`);
  let endpoint;
  try { endpoint = new URL(values[1]); } catch { throw new Error("R2_ENDPOINT must be the Cloudflare S3 endpoint URL."); }
  if (endpoint.protocol !== "https:" || !/^[a-z0-9]+(?:\.(?:eu|fedramp))?\.r2\.cloudflarestorage\.com$/.test(endpoint.hostname) ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !["", "/"].includes(endpoint.pathname) || endpoint.port) {
    throw new Error("R2_ENDPOINT must be https://<account-id>.r2.cloudflarestorage.com (without a bucket path).");
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(values[0])) throw new Error("Invalid R2_BUCKET_NAME.");
  const signature = JSON.stringify(values);
  if (!cached || cached.signature !== signature) {
    cached = {
      signature, bucket: values[0],
      client: new S3Client({
        region: "auto", endpoint: endpoint.origin, forcePathStyle: true,
        credentials: { accessKeyId: values[2], secretAccessKey: values[3] },
        maxAttempts: 4, requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
        requestHandler: { connectionTimeout: 10000, requestTimeout: 45000 },
      }),
    };
  }
  return cached.bucket;
}
function storage() { feedStorageRoot(); return cached; }
async function send(Command, input) {
  const { client, bucket } = storage();
  return client.send(new Command({ Bucket: bucket, ...input }));
}
function missing(error) { return error?.$metadata?.httpStatusCode === 404 || ["NoSuchKey", "NotFound"].includes(error?.name); }
function conflict(error) { return [409, 412].includes(error?.$metadata?.httpStatusCode); }
function message(error) {
  if ([401, 403].includes(error?.$metadata?.httpStatusCode) || ["SignatureDoesNotMatch", "InvalidAccessKeyId", "AccessDenied"].includes(error?.name)) {
    return "R2 rejected the credentials or bucket permissions. Use the S3 Access Key ID and Secret Access Key (not the API token value), with Object Read & Write access to this bucket.";
  }
  if (error?.name === "NoSuchBucket") return "R2_BUCKET_NAME does not match an existing bucket in this account.";
  if (conflict(error)) return "Another worker updated this export. Refresh its status before retrying.";
  return String(error?.message || "R2 export failed.").slice(0, 1000);
}
function shopPrefix(shop) {
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) throw new Error("Invalid shop.");
  return `ymmt-feeds/${createHash("sha256").update(shop).digest("hex")}`;
}
function jobPrefix(shop, id) {
  if (!UUID.test(id)) throw new Error("Invalid export ID.");
  return `${shopPrefix(shop)}/${id}`;
}
function stateKey(shop, id) { return `${jobPrefix(shop, id)}/job.json`; }
async function readJson(key) {
  try {
    const result = await send(GetObjectCommand, { Key: key });
    return { value: JSON.parse(await result.Body.transformToString()), etag: result.ETag };
  } catch (error) { if (missing(error)) return null; throw new Error(message(error)); }
}
async function putJson(key, value, condition = {}) {
  const result = await send(PutObjectCommand, {
    Key: key, Body: JSON.stringify(value), ContentType: "application/json", ...condition,
  });
  if (!result.ETag) throw new Error("R2 did not return a checkpoint ETag.");
  return result.ETag;
}
async function discard(key) {
  if (!key) return;
  try { await send(DeleteObjectCommand, { Key: key }); }
  catch { /* Cleanup failure must not invalidate a completed checkpoint. */ }
}

// A conditional R2 write protects concurrent Create/Retry requests across processes.
async function withShopLock(shop, work) {
  const key = `${shopPrefix(shop)}/request-lock.json`;
  const previous = await readJson(key);
  if (previous && previous.value.expires > Date.now()) throw new Error("Another export request is being prepared. Try again shortly.");
  let etag;
  try { etag = await putJson(key, { expires: Date.now() + LEASE_MS }, previous ? { IfMatch: previous.etag } : { IfNoneMatch: "*" }); }
  catch (error) { throw new Error(message(error)); }
  try { return await work(); }
  finally {
    try { await putJson(key, { expires: 0 }, { IfMatch: etag }); } catch { /* A stale lock expires automatically. */ }
  }
}

export async function getFeedJob(shop, id) {
  const entry = await readJson(stateKey(shop, id));
  const job = entry?.value;
  if (job && (job.shop !== shop || job.id !== id)) throw new Error("Export ownership mismatch.");
  return job || null;
}
export async function getLatestFeedJob(shop) {
  const index = await readJson(`${shopPrefix(shop)}/latest.json`);
  return index ? getFeedJob(shop, index.value.id) : null;
}

// A small PUT + GET + DELETE verifies actual S3 read/write access before Shopify queries.
export async function checkFeedStorage(shop) {
  const key = `${shopPrefix(shop)}/checks/${randomUUID()}`;
  const value = randomUUID();
  try {
    await send(PutObjectCommand, { Key: key, Body: value, ContentType: "text/plain" });
    const result = await send(GetObjectCommand, { Key: key });
    if (await result.Body.transformToString() !== value) throw new Error("R2 connection check did not return the expected data.");
    await send(DeleteObjectCommand, { Key: key });
  } catch (error) { await discard(key); throw new Error(message(error)); }
}

export async function createFeedJob(shop, year) {
  if (year && (!/^\d{4}$/.test(year) || Number(year) < 1996 || Number(year) > 2027)) throw new Error("Select a year from 1996 to 2027, or All years.");
  await checkFeedStorage(shop);
  return withShopLock(shop, async () => {
    const current = await getLatestFeedJob(shop);
    if (current && ACTIVE.has(current.status)) return current;
    const job = {
      schema: 2, id: randomUUID(), shop, year, token: randomBytes(32).toString("hex"),
      status: "queued", error: "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      cursor: null, seenCursors: [], started: false, footerWritten: false,
      chunks: [], pending: null, pagesChecked: 0, pagesIncluded: 0, offers: 0,
      bytes: 0, gzipBytes: 0, currency: "", attempts: 0, leaseUntil: 0,
    };
    await putJson(stateKey(shop, job.id), job, { IfNoneMatch: "*" });
    await putJson(`${shopPrefix(shop)}/latest.json`, { id: job.id });
    return job;
  });
}

async function loadChunk(chunk) {
  const result = await send(GetObjectCommand, { Key: chunk.key });
  const buffer = Buffer.from(await result.Body.transformToByteArray());
  if (buffer.length !== chunk.size) throw new Error("An export checkpoint chunk is incomplete. Create a new export.");
  return buffer;
}

// Fixed-size immutable chunks allow safe recovery without serializing a gzip stream.
class ChunkWriter {
  constructor(job, buffer, assertOwner) {
    this.job = job; this.buffer = Buffer.allocUnsafe(PART_SIZE); this.length = buffer.length;
    buffer.copy(this.buffer); this.assertOwner = assertOwner;
  }
  async write(value) {
    let input = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
    this.job.bytes += input.length;
    while (input.length) {
      const take = Math.min(PART_SIZE - this.length, input.length);
      input.copy(this.buffer, this.length, 0, take); this.length += take;
      input = input.subarray(take);
      if (this.length === PART_SIZE) {
        this.job.chunks.push(await this.store(this.buffer));
        this.buffer = Buffer.allocUnsafe(PART_SIZE); this.length = 0;
      }
    }
  }
  async store(buffer) {
    await this.assertOwner();
    const key = `${jobPrefix(this.job.shop, this.job.id)}/staging/${randomUUID()}`;
    await send(PutObjectCommand, { Key: key, Body: buffer, ContentType: "application/octet-stream" });
    return { key, size: buffer.length };
  }
  async checkpoint(commit) {
    const old = this.job.pending;
    this.job.pending = this.length ? await this.store(this.buffer.subarray(0, this.length)) : null;
    await commit(this.job);
    await discard(old?.key);
  }
}

// Uploads are invisible until CompleteMultipartUpload. Every part except the last is 8 MiB.
async function uploadStream(key, contentType, iterable, assertOwner) {
  await assertOwner();
  const created = await send(CreateMultipartUploadCommand, { Key: key, ContentType: contentType });
  if (!created.UploadId) throw new Error("R2 did not start the multipart upload.");
  const UploadId = created.UploadId;
  const parts = [];
  let buffer = Buffer.allocUnsafe(PART_SIZE); let length = 0; let bytes = 0;
  async function upload(body) {
    await assertOwner();
    if (parts.length >= 10000) throw new Error("Export exceeded the multipart limit. Export individual years instead.");
    const PartNumber = parts.length + 1;
    const result = await send(UploadPartCommand, { Key: key, UploadId, PartNumber, Body: body });
    if (!result.ETag) throw new Error("R2 did not confirm the uploaded part.");
    parts.push({ PartNumber, ETag: result.ETag });
    bytes += body.length;
  }
  try {
    for await (const value of iterable) {
      let input = Buffer.from(value);
      while (input.length) {
        const take = Math.min(PART_SIZE - length, input.length);
        input.copy(buffer, length, 0, take); length += take;
        input = input.subarray(take);
        if (length === PART_SIZE) { await upload(buffer); buffer = Buffer.allocUnsafe(PART_SIZE); length = 0; }
      }
    }
    if (length || !parts.length) await upload(buffer.subarray(0, length));
    await assertOwner();
    await send(CompleteMultipartUploadCommand, { Key: key, UploadId, MultipartUpload: { Parts: parts } });
    const head = await send(HeadObjectCommand, { Key: key });
    if (head.ContentLength !== bytes) throw new Error("R2 completed file size did not match the upload.");
    return bytes;
  } catch (error) {
    try { await send(AbortMultipartUploadCommand, { Key: key, UploadId }); } catch { /* R2 lifecycle aborts abandoned uploads. */ }
    throw error;
  }
}

async function runJob(shop, id, admin, retry) {
  const key = stateKey(shop, id);
  const entry = await readJson(key);
  if (!entry) return;
  let job = entry.value;
  if (job.status === "ready" || (job.status === "failed" && !retry) || job.leaseUntil > Date.now()) return;
  let etag = entry.etag;
  const owner = randomUUID();
  job.worker = owner; job.leaseUntil = Date.now() + LEASE_MS;
  job.status = job.footerWritten ? "validating" : "building";
  job.error = ""; job.attempts++; job.updatedAt = new Date().toISOString();
  try { etag = await putJson(key, job, { IfMatch: etag }); }
  catch (error) { if (conflict(error)) return; throw new Error(message(error)); }
  // Only this serialized queue updates the state ETag. Heartbeats persist the last
  // committed checkpoint, never an in-progress batch or uncommitted chunk list.
  let committed = structuredClone(job);
  let tail = Promise.resolve(); let lost = false;
  function assertOwner() { if (lost) throw new Error("Export worker ownership changed. Refresh to resume."); }
  function commit(next) {
    const snapshot = next ? structuredClone(next) : null;
    const work = tail.then(async () => {
      assertOwner();
      const value = snapshot || structuredClone(committed);
      value.worker = owner; value.leaseUntil = Date.now() + LEASE_MS; value.updatedAt = new Date().toISOString();
      try { etag = await putJson(key, value, { IfMatch: etag }); }
      catch (error) { lost = true; throw error; }
      committed = value;
      job.updatedAt = value.updatedAt;
    });
    tail = work.catch(() => {});
    return work;
  }
  const attemptKeys = [];
  const timer = setInterval(() => { commit().catch(() => {}); }, 30000);
  timer.unref?.();
  try {
    if (!job.currency) {
      const data = await graphqlWithRetry(admin, `#graphql\nquery FeedShop { shop { currencyCode } }`);
      job.currency = data.shop?.currencyCode || "";
      if (!job.currency) throw new Error("Shopify did not return the store currency.");
      await commit(job);
    }
    if (!job.footerWritten) {
      const writer = new ChunkWriter(job, job.pending ? await loadChunk(job.pending) : Buffer.alloc(0), assertOwner);
      if (!job.started) { await writer.write(feedHeader(shop)); job.started = true; }
      const cache = new Map(); const signal = new AbortController().signal;
      while (true) {
        assertOwner();
        const connection = await getPageBatch(admin, job.cursor, job.year);
        if (!Array.isArray(connection.nodes) || !connection.pageInfo) throw new Error("Shopify returned an incomplete page batch.");
        for (const page of connection.nodes) {
          assertOwner();
          const include = page.templateSuffix === "product-ymmt" && page.isPublished && (!job.year || pageYear(page) === job.year);
          if (include) {
            const product = await linkedProduct(admin, page, cache, signal);
            if (!product.variants.length) throw new Error(`Product ${product.handle} has no variants.`);
            for (const variant of product.variants) await writer.write(renderItem(page, product, variant, `https://${shop}`, job.currency));
            job.pagesIncluded++; job.offers += product.variants.length;
          }
          job.pagesChecked++;
        }
        if (!connection.pageInfo.hasNextPage) {
          await writer.write(FEED_FOOTER); job.footerWritten = true; job.status = "validating";
          await writer.checkpoint(commit); break;
        }
        const cursor = connection.pageInfo.endCursor;
        if (!cursor || job.seenCursors.includes(cursor)) throw new Error("Shopify repeated or omitted a page cursor. Create a new export.");
        job.seenCursors.push(cursor); job.cursor = cursor;
        await writer.checkpoint(commit);
      }
    }
    // Validate XML across chunk boundaries and count offers before completing the upload.
    const parser = sax.parser(true, { xmlns: true });
    const decoder = new StringDecoder("utf8"); let offers = 0; let root = "";
    parser.onopentag = (node) => { if (!root) root = node.name; if (node.name === "item") offers++; };
    const chunks = [...job.chunks, ...(job.pending ? [job.pending] : [])];
    const xmlKey = `${jobPrefix(shop, id)}/files/${owner}.xml`;
    attemptKeys.push(xmlKey);
    async function* xmlStream() {
      for (const chunk of chunks) {
        assertOwner(); const buffer = await loadChunk(chunk);
        parser.write(decoder.write(buffer)); yield buffer;
      }
      parser.write(decoder.end()); parser.close();
      if (root !== "rss" || offers !== job.offers) throw new Error("The completed XML failed its offer-count validation.");
    }
    const xmlBytes = await uploadStream(xmlKey, "application/xml; charset=utf-8", xmlStream(), assertOwner);
    if (xmlBytes !== job.bytes) throw new Error("The completed XML size does not match its checkpoint.");
    job.status = "compressing"; await commit(job);
    const gzipKey = `${jobPrefix(shop, id)}/files/${owner}.xml.gz`;
    attemptKeys.push(gzipKey);
    const source = await send(GetObjectCommand, { Key: xmlKey });
    const gzip = createGzip({ level: 6 });
    const pump = pipeline(source.Body instanceof Readable ? source.Body : Readable.from(source.Body), gzip);
    pump.catch(() => {});
    try {
      job.gzipBytes = await uploadStream(gzipKey, "application/gzip", gzip, assertOwner);
      await pump;
    } catch (error) { gzip.destroy(); source.Body.destroy?.(); await pump.catch(() => {}); throw error; }
    job.xmlKey = xmlKey; job.gzipKey = gzipKey;
    job.status = "ready"; job.completedAt = new Date().toISOString();
    const staging = [...job.chunks, ...(job.pending ? [job.pending] : [])];
    job.chunks = []; job.pending = null;
    clearInterval(timer); await tail;
    await commit(job);
    // Delete staging only after the ready checkpoint is durably committed.
    for (const chunk of staging) await discard(chunk.key);
  } catch (error) {
    // Do not log the SDK request, credentials, or presigned URLs.
    console.error("Google feed export failed:", { shop, id, name: error?.name, message: message(error) });
    clearInterval(timer); await tail;
    if (!lost) {
      const failed = structuredClone(committed);
      failed.status = "failed"; failed.error = message(error);
      await commit(failed).catch(() => {});
    }
    for (const output of attemptKeys) await discard(output);
  } finally { clearInterval(timer); }
}

export async function queueFeedRetry(shop, id) {
  await checkFeedStorage(shop);
  return withShopLock(shop, async () => {
    const entry = await readJson(stateKey(shop, id));
    if (!entry || entry.value.shop !== shop || entry.value.id !== id) throw new Error("Export not found.");
    const job = entry.value;
    if (job.status === "failed") {
      const latest = await getLatestFeedJob(shop);
      if (latest && latest.id !== id && ACTIVE.has(latest.status)) throw new Error("Another export is in progress. Wait for it to finish.");
      job.status = "queued"; job.error = ""; job.leaseUntil = 0; job.updatedAt = new Date().toISOString();
      await putJson(stateKey(shop, id), job, { IfMatch: entry.etag });
      await putJson(`${shopPrefix(shop)}/latest.json`, { id });
    }
    return job;
  });
}
export function startFeedJob(shop, id, admin, { retry = false } = {}) {
  const key = `${shop}:${id}`;
  if (running.has(key)) return running.get(key);
  const work = runJob(shop, id, admin, retry).catch((error) => {
    console.error("Google feed worker failed:", { shop, id, message: message(error) });
  }).finally(() => running.delete(key));
  running.set(key, work); return work;
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
    url.searchParams.set("shop", job.shop); url.searchParams.set("job", job.id); url.searchParams.set("token", job.token);
    result.xmlUrl = url.toString(); url.searchParams.set("format", "gzip"); result.gzipUrl = url.toString();
  }
  return result;
}
function validToken(token, expected) {
  if (!/^[0-9a-f]{64}$/.test(token || "") || !/^[0-9a-f]{64}$/.test(expected || "")) return false;
  return timingSafeEqual(Buffer.from(token, "hex"), Buffer.from(expected, "hex"));
}
export async function downloadFeed(request) {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") || ""; const id = url.searchParams.get("job") || "";
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) || !UUID.test(id)) return new Response("Create an export from Google Feed first.", { status: 400 });
  if (!["GET", "HEAD"].includes(request.method)) return new Response("Method not allowed.", { status: 405 });
  const job = await getFeedJob(shop, id);
  if (!job || !validToken(url.searchParams.get("token"), job.token)) return new Response("Download not found.", { status: 404 });
  if (job.status !== "ready") return new Response("This export is not ready.", { status: 409 });
  const compressed = url.searchParams.get("format") === "gzip";
  const Key = compressed ? job.gzipKey : job.xmlKey;
  if (!Key?.startsWith(`${jobPrefix(shop, id)}/files/`)) return new Response("Saved file not found.", { status: 404 });
  const { client, bucket } = storage();
  try { await send(HeadObjectCommand, { Key }); }
  catch (error) { if (missing(error)) return new Response("This saved file has expired or was deleted. Create a new export.", { status: 410 }); throw new Error(message(error)); }
  const name = `google-feed-${job.year || "all-years"}-${id}${compressed ? ".xml.gz" : ".xml"}`;
  // Browser downloads bytes directly from R2. A new link is minted on every click;
  // signed URLs last seven days, R2's maximum, to accommodate slow large transfers.
  const input = { Bucket: bucket, Key };
  if (request.method === "GET") input.ResponseContentDisposition = `attachment; filename="${name}"`;
  const Command = request.method === "HEAD" ? HeadObjectCommand : GetObjectCommand;
  const location = await getSignedUrl(client, new Command(input), { expiresIn: 604800 });
  return new Response(null, { status: 307, headers: { Location: location, "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" } });
}
