/** Cached, asynchronous readiness: health requests never perform blocking I/O. */
import { BlobForumStore, FORUM_BLOB, MAX_FORUM_BYTES } from "./forum-blob";
export function createForumHealth(read: () => Promise<boolean>, now = Date.now) {
  let checked = -Infinity, ok = false, pending: Promise<void> | null = null;
  return () => {
    if (!pending && now() - checked >= 15000) {
      pending = Promise.resolve().then(read).then(value => { ok = value; }, () => { ok = false; })
        .finally(() => { checked = now(); pending = null; });
    }
    return { status: ok && now() - checked < 30000 ? "ok" : "unavailable", storage: "blob", concurrency: "etag" };
  };
}
async function readForum(): Promise<boolean> {
  const account = process.env.S3RCH_FORUM_BLOB_ACCOUNT || "";
  const container = process.env.S3RCH_FORUM_BLOB_CONTAINER || "";
  if (!/^[a-z0-9]{3,24}$/.test(account) || !/^[a-z0-9](?:[a-z0-9]|-(?!-)){1,61}[a-z0-9]$/.test(container)) return false;
  const [{ ManagedIdentityCredential }, { BlobServiceClient }] = await Promise.all([
    import("@azure/identity"), import("@azure/storage-blob"),
  ]);
  const blob = new BlobServiceClient(`https://${account}.blob.core.windows.net`, new ManagedIdentityCredential())
    .getContainerClient(container).getBlockBlobClient(FORUM_BLOB);
  const response = await blob.download(0, MAX_FORUM_BYTES + 1, { abortSignal: AbortSignal.timeout(4000) });
  if (!response.etag || !response.readableStreamBody) return false;
  const chunks: Buffer[] = []; let size = 0;
  for await (const part of response.readableStreamBody) {
    const bytes = Buffer.from(part); size += bytes.length;
    if (size > MAX_FORUM_BYTES) return false;
    chunks.push(bytes);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return new BlobForumStore({ assertReachable() {},
    download: () => ({ found: true, text, etag: response.etag! }),
    upload: () => { throw new Error("Read-only health probe"); },
  }).load().ok;
}
const cached = createForumHealth(readForum);
export function forumHealth() {
  const mode = process.env.S3RCH_FORUM_STORAGE || "file";
  if (mode === "file") return { status: "ok", storage: "file", concurrency: "single-process" };
  if (mode !== "blob") return { status: "unavailable", storage: mode, concurrency: "unavailable" };
  return cached();
}
