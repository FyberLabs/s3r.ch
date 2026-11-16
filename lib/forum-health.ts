/** Cached, asynchronous readiness: health requests never perform blocking I/O. */
import { BlobForumStore, configuredAdmissions } from "./forum-blob";
import { forumAsyncClient } from "./forum-blob-async";
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
  const owners = configuredAdmissions();
  const hit = await (await forumAsyncClient()).download();
  const store = new BlobForumStore({assertReachable() {}, download:()=>hit,
    upload:()=>{throw new Error("Read-only health probe");}});
  return store.load().ok && owners.every(owner=>store.admits(owner));
}

const cached = createForumHealth(readForum);
export function forumHealth() {
  const mode = process.env.S3RCH_FORUM_STORAGE || "file";
  if (mode === "file") return { status: "ok", storage: "file", concurrency: "single-process" };
  if (mode !== "blob") return { status: "unavailable", storage: mode, concurrency: "unavailable" };
  return cached();
}
