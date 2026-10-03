import { createHash, randomUUID } from "node:crypto";
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
let cache;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function repairStorage() {
  const env = ["R2_BUCKET_NAME", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"];
  const values = env.map((key) => process.env[key]?.trim());
  if (values.some((value) => !value)) throw new Error(`Configure ${env.filter((_, i) => !values[i]).join(", ")} in Railway.`);
  const endpoint = new URL(values[1]);
  if (endpoint.protocol !== "https:" || !/^[a-z0-9]+(?:\.(?:eu|us|fedramp))?\.r2\.cloudflarestorage\.com$/.test(endpoint.hostname) || endpoint.pathname !== "/" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.port) throw new Error("Use the Cloudflare R2 S3 endpoint without a bucket path.");
  const signature = JSON.stringify(values);
  if (cache?.signature !== signature) cache = { signature, bucket: values[0], client: new S3Client({ region: "auto", endpoint: endpoint.origin, forcePathStyle: true, credentials: { accessKeyId: values[2], secretAccessKey: values[3] }, maxAttempts: 3, requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED", requestHandler: { connectionTimeout: 10000, requestTimeout: 45000 } }) };
  return cache;
}
export function repairPrefix(shop, id = "") {
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) || (id && !UUID.test(id))) throw new Error("Invalid repair job.");
  return `ymmt-repairs/${createHash("sha256").update(shop).digest("hex")}${id ? `/${id}` : ""}`;
}
export function repairError(error) {
  if ([401, 403].includes(error?.$metadata?.httpStatusCode) || error?.name === "SignatureDoesNotMatch") return "R2 access failed. Check the S3 credentials and Object Read & Write bucket permissions.";
  if ([409, 412].includes(error?.$metadata?.httpStatusCode)) return "Another request updated this job. Refresh and resume.";
  return String(error?.message || "Repair job failed.").slice(0, 1000);
}
export async function readRepairJson(key) {
  const { client, bucket } = repairStorage();
  try { const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key })); return { value: JSON.parse(await response.Body.transformToString()), etag: response.ETag }; }
  catch (error) { if (error?.$metadata?.httpStatusCode === 404 || error?.name === "NoSuchKey") return null; throw error; }
}
export async function writeRepairJson(key, value, condition = {}) {
  const { client, bucket } = repairStorage();
  const response = await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: JSON.stringify(value), ContentType: "application/json", ...condition }));
  if (!response.ETag) throw new Error("R2 did not confirm the checkpoint.");
  return response.ETag;
}
export async function removeRepairObject(key) {
  if (!key) return;
  try { const { client, bucket } = repairStorage(); await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })); } catch { /* Checkpoints remain valid if cleanup fails. */ }
}
export async function uniqueRepairJson(prefix, value) {
  const key = `${prefix}/${randomUUID()}.json`; await writeRepairJson(key, value, { IfNoneMatch: "*" }); return key;
}
