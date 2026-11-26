// AWS Signature Version 4 query-string signing (a presigned URL), enough for R2's S3 API. The payload is never signed
// (UNSIGNED-PAYLOAD); headers listed in `headers` are signed, so the caller must send exactly those values.

const encoder = new TextEncoder();
const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, "0")).join("");
const hmac = async (key: ArrayBuffer | string, data: string) =>
  crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", typeof key === "string" ? encoder.encode(key) : key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), encoder.encode(data));
/** RFC 3986 percent-encoding, as SigV4 requires (encodeURIComponent leaves `!'()*`). */
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export interface PresignInput {
  method: string;
  host: string;
  /** The object path, starting with `/`; each segment is encoded here. */
  path: string;
  /** Headers to sign besides `host`. */
  headers?: Record<string, string>;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  expiresSeconds: number;
  now: Date;
}

export async function presign(input: PresignInput): Promise<string> {
  const stamp = input.now.toISOString().replace(/[-:]|\.\d{3}/g, "");
  const scope = `${stamp.slice(0, 8)}/${input.region}/${input.service}/aws4_request`;
  const headers = Object.entries({ host: input.host, ...input.headers }).map(([name, value]) => [name.toLowerCase(), value.trim()]).sort(([a], [b]) => a < b ? -1 : 1);
  const signedHeaders = headers.map(([name]) => name).join(";");
  const query = Object.entries({
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256", "X-Amz-Credential": `${input.accessKeyId}/${scope}`, "X-Amz-Date": stamp,
    "X-Amz-Expires": String(input.expiresSeconds), "X-Amz-SignedHeaders": signedHeaders,
  }).map(([name, value]) => [encode(name), encode(value)]).sort(([a], [b]) => a < b ? -1 : 1).map(pair => pair.join("=")).join("&");
  const path = input.path.split("/").map(encode).join("/");
  const request = [input.method, path, query, headers.map(([name, value]) => `${name}:${value}\n`).join(""), signedHeaders, "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", stamp, scope, hex(await crypto.subtle.digest("SHA-256", encoder.encode(request)))].join("\n");
  let key = await hmac(`AWS4${input.secretAccessKey}`, stamp.slice(0, 8));
  for (const part of [input.region, input.service, "aws4_request"]) key = await hmac(key, part);
  return `https://${input.host}${path}?${query}&X-Amz-Signature=${hex(await hmac(key, toSign))}`;
}
