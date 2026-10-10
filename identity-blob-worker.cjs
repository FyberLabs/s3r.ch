// Azure Blob worker for the identity document. The parent blocks on a reply
// port so LinkStore can stay synchronous. One private blob holds the document.
const { parentPort } = require("node:worker_threads");
const { DefaultAzureCredential } = require("@azure/identity");
const { BlobServiceClient } = require("@azure/storage-blob");

const MAX_BYTES = 1048576;
let replyPort = null;
let shared = null;
let container = null;

function reply(message) {
  replyPort.postMessage(message);
  Atomics.store(shared, 0, 1);
  Atomics.notify(shared, 0);
}

function statusOf(error) {
  return (error && (error.statusCode || error.status)) || 0;
}

function failure(error) {
  const status = statusOf(error);
  if (status === 412 || status === 409) return { ok: false, code: "blob-conflict", status };
  if (status === 404) return { ok: false, status, reason: "not-found" };
  if (status === 401 || status === 403) return { ok: false, status, reason: "forbidden" };
  return { ok: false, status, reason: "unreachable" };
}

async function readBody(stream) {
  if (!stream) return "";
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_BYTES) {
      const error = new Error("identity blob is too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function handle(msg) {
  const signal = AbortSignal.timeout(15000);
  if (msg.op === "reachable") {
    await container.getProperties({ abortSignal: signal });
    return { ok: true };
  }
  const blob = container.getBlockBlobClient(msg.blobName);
  if (msg.op === "download") {
    try {
      const response = await blob.download(0, undefined, { abortSignal: signal });
      const text = await readBody(response.readableStreamBody);
      if (!response.etag) return { ok: false, reason: "unreachable", status: 0 };
      return { ok: true, found: true, text, etag: response.etag };
    } catch (error) {
      if (statusOf(error) === 404) return { ok: true, found: false };
      return failure(error);
    }
  }
  if (msg.op === "upload") {
    const body = Buffer.from(msg.text, "utf8");
    if (body.length > MAX_BYTES) return { ok: false, status: 413, reason: "unreachable" };
    const conditions = {};
    if (msg.conditions && msg.conditions.ifMatch) conditions.ifMatch = msg.conditions.ifMatch;
    if (msg.conditions && msg.conditions.ifNoneMatch) conditions.ifNoneMatch = msg.conditions.ifNoneMatch;
    const response = await blob.upload(body, body.length, {
      conditions,
      abortSignal: signal,
      blobHTTPHeaders: {
        blobContentType: "application/json",
        blobCacheControl: "no-store",
      },
    });
    if (!response.etag) return { ok: false, reason: "unreachable", status: 0 };
    return { ok: true, etag: response.etag };
  }
  return { ok: false, reason: "unreachable", status: 0 };
}

parentPort.on("message", async (msg) => {
  try {
    if (msg && msg.op === "init") {
      replyPort = msg.port;
      shared = new Int32Array(msg.shared);
      const credential = new DefaultAzureCredential();
      const service = new BlobServiceClient(`https://${msg.account}.blob.core.windows.net`, credential);
      container = service.getContainerClient(msg.container);
      reply({ ok: true });
      return;
    }
    reply(await handle(msg));
  } catch (error) {
    if (replyPort && shared) reply(failure(error));
  }
});
