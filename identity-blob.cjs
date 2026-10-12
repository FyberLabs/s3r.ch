// Production account links live in one private Azure Blob.
// The App Service managed identity is the only credential. This file does not
// read a storage connection string or an account key.
const fs = require("node:fs");
const path = require("node:path");
const { MessageChannel, Worker, receiveMessageOnPort } = require("node:worker_threads");

const IDENTITY_BLOB_NAME = "identity-links.json";
const IDENTITY_BLOB_MAX_BYTES = 1048576;
const EMPTY_DOCUMENT = JSON.stringify({ v: 1, people: [] });

// Loaded here so the standalone server trace includes the SDK the worker uses.
require("@azure/identity");
require("@azure/storage-blob");

const ACCOUNT_NAME = /^[a-z0-9]{3,24}$/;
const CONTAINER_NAME = /^[a-z0-9](?:[a-z0-9]|-(?!-)){1,61}[a-z0-9]$/;

function blobServiceUrl(account) {
  return `https://${account}.blob.core.windows.net`;
}

function readBlobConfig(env = process.env) {
  const account = String(env.S3RCH_IDENTITY_BLOB_ACCOUNT || "").trim();
  const container = String(env.S3RCH_IDENTITY_BLOB_CONTAINER || "").trim();
  if (!ACCOUNT_NAME.test(account) || !CONTAINER_NAME.test(container)) {
    throw new Error(
      "s3r.ch: configure S3RCH_IDENTITY_BLOB_ACCOUNT and S3RCH_IDENTITY_BLOB_CONTAINER for durable identity storage",
    );
  }
  return { account, container, url: blobServiceUrl(account) };
}

function blobConflict() {
  const error = new Error("identity blob write conflict");
  error.code = "blob-conflict";
  return error;
}

function workerFile() {
  const candidates = [
    path.join(__dirname, "identity-blob-worker.cjs"),
    path.join(process.cwd(), "identity-blob-worker.cjs"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function workerEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  // Managed identity only. A client secret or CLI login must not win.
  env.AZURE_TOKEN_CREDENTIALS = "ManagedIdentityCredential";
  env.AZURE_LOG_LEVEL = "error";
  delete env.AZURE_STORAGE_CONNECTION_STRING;
  delete env.AZURE_STORAGE_KEY;
  delete env.AZURE_STORAGE_ACCOUNT_KEY;
  delete env.AZURE_CLIENT_SECRET;
  delete env.AZURE_CLIENT_CERTIFICATE_PATH;
  delete env.AZURE_CLIENT_CERTIFICATE_PASSWORD;
  return env;
}

// Loading @azure/identity and @azure/storage-blob in the worker can take tens
// of seconds on a busy App Service plan. Keep the default well under the
// App Service container start limit (230 s by default).
const DEFAULT_WORKER_START_TIMEOUT_MS = 60000;
// Capped so the later blob checks (20 s each) still fit in the 230 s window.
const MAX_WORKER_START_TIMEOUT_MS = 120000;

function workerStartTimeoutMs(env = process.env) {
  const raw = String(env.S3RCH_IDENTITY_WORKER_START_TIMEOUT_MS || "").trim();
  if (!raw) return DEFAULT_WORKER_START_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1000) return DEFAULT_WORKER_START_TIMEOUT_MS;
  return Math.min(value, MAX_WORKER_START_TIMEOUT_MS);
}

function createBlockingWorker(workerPath, initMessage, timeoutMs = 20000, startTimeoutMs = workerStartTimeoutMs()) {
  const { port1, port2 } = new MessageChannel();
  const shared = new Int32Array(new SharedArrayBuffer(4));
  // execArgv: [] keeps `node -r ./gun-preload.cjs` from running the preload,
  // and with it another storage check, inside this worker.
  const worker = new Worker(workerPath, { env: workerEnv(), execArgv: [] });
  let failed = null;
  worker.on("error", (error) => {
    failed = error;
    Atomics.store(shared, 0, 1);
    Atomics.notify(shared, 0);
  });
  worker.on("exit", (code) => {
    if (code !== 0) {
      failed = failed || new Error("identity blob worker exited");
      Atomics.store(shared, 0, 1);
      Atomics.notify(shared, 0);
    }
  });

  function failedReason() {
    const detail = failed && failed.message ? failed.message : "unknown error";
    return `s3r.ch: identity blob worker failed: ${detail}`;
  }

  function waitForReply(waitMs, phase) {
    const status = Atomics.wait(shared, 0, 0, waitMs);
    if (failed) throw new Error(failedReason());
    if (status === "timed-out") {
      const seconds = Math.round(waitMs / 1000);
      throw new Error(
        phase === "start"
          ? `s3r.ch: identity blob worker did not start within ${seconds}s (S3RCH_IDENTITY_WORKER_START_TIMEOUT_MS)`
          : `s3r.ch: identity blob storage did not answer within ${seconds}s`,
      );
    }
    const received = receiveMessageOnPort(port1);
    if (!received || !received.message) {
      throw new Error("s3r.ch: identity blob worker sent no reply");
    }
    return received.message;
  }

  function call(message) {
    if (failed) throw new Error(failedReason());
    Atomics.store(shared, 0, 0);
    worker.postMessage(message);
    return waitForReply(timeoutMs, "call");
  }

  Atomics.store(shared, 0, 0);
  worker.postMessage(
    { ...initMessage, op: "init", port: port2, shared: shared.buffer },
    [port2],
  );
  let ready;
  try {
    ready = waitForReply(startTimeoutMs, "start");
  } catch (error) {
    worker.terminate();
    throw error;
  }
  if (!ready.ok) {
    worker.terminate();
    const detail = ready.detail ? `: ${ready.detail}` : "";
    throw new Error(`s3r.ch: identity blob worker failed to start (${ready.reason || "unknown"}${ready.status ? ` ${ready.status}` : ""})${detail}`);
  }
  return {
    call,
    terminate() {
      return worker.terminate();
    },
  };
}

function interpretBlobReply(message) {
  if (message && message.ok) return message;
  if (message && message.code === "blob-conflict") throw blobConflict();
  if (message && message.reason === "forbidden") {
    throw new Error(
      "s3r.ch: identity blob storage refused access. Assign the Storage Blob Data Contributor role to the app identity.",
    );
  }
  if (message && message.reason === "not-found") {
    throw new Error("s3r.ch: identity blob container is missing or unreachable");
  }
  throw new Error("s3r.ch: identity blob storage is unreachable");
}

function createProductionBlobClient(config) {
  const bridge = createBlockingWorker(workerFile(), {
    account: config.account,
    container: config.container,
  });
  return {
    assertReachable() {
      interpretBlobReply(bridge.call({ op: "reachable" }));
    },
    download(blobName) {
      const message = bridge.call({ op: "download", blobName });
      if (message && message.ok && message.found === false) return { found: false };
      const body = interpretBlobReply(message);
      return { found: true, text: body.text, etag: body.etag };
    },
    upload(blobName, text, conditions) {
      const message = interpretBlobReply(bridge.call({ op: "upload", blobName, text, conditions }));
      return { etag: message.etag };
    },
  };
}

function assertBlobReady(config, client) {
  try {
    client.assertReachable();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("s3r.ch:")) throw error;
    throw new Error("s3r.ch: identity blob storage is unreachable");
  }
  let downloaded;
  try {
    downloaded = client.download(IDENTITY_BLOB_NAME);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("s3r.ch:")) throw error;
    throw new Error("s3r.ch: identity blob storage is unreachable");
  }
  if (!downloaded.found) {
    try {
      client.upload(IDENTITY_BLOB_NAME, EMPTY_DOCUMENT, { ifNoneMatch: "*" });
    } catch (error) {
      if (!error || error.code !== "blob-conflict") {
        if (error instanceof Error && error.message.startsWith("s3r.ch:")) throw error;
        throw new Error("s3r.ch: identity blob storage is unreachable");
      }
    }
    try {
      downloaded = client.download(IDENTITY_BLOB_NAME);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("s3r.ch:")) throw error;
      throw new Error("s3r.ch: identity blob storage is unreachable");
    }
    if (!downloaded.found) throw new Error("s3r.ch: identity blob storage is unreachable");
  }
  if (typeof downloaded.text !== "string" || Buffer.byteLength(downloaded.text) > IDENTITY_BLOB_MAX_BYTES) {
    throw new Error("s3r.ch: identity store is invalid; refusing to start");
  }
  let parsed;
  try {
    parsed = JSON.parse(downloaded.text);
  } catch {
    throw new Error("s3r.ch: identity store is invalid; refusing to start");
  }
  if (!require("./identity-link-schema.cjs").parseLinkFile(parsed).ok) {
    throw new Error("s3r.ch: identity store is invalid; refusing to start");
  }
}

module.exports = {
  IDENTITY_BLOB_NAME,
  IDENTITY_BLOB_MAX_BYTES,
  EMPTY_DOCUMENT,
  readBlobConfig,
  blobServiceUrl,
  blobConflict,
  createBlockingWorker,
  workerStartTimeoutMs,
  DEFAULT_WORKER_START_TIMEOUT_MS,
  interpretBlobReply,
  createProductionBlobClient,
  assertBlobReady,
};
