/** Unmounted browser transport. Caller owns provider selection and current grant/consent. */
import { IPFS_MEDIA_BLOCK_BYTES, rawMediaBlockCid } from "./ipfs-media-blocks";
const denied = () => new Error("IPFS transfer unavailable");
export function createKuboBlockClient(options: {
  endpoint: string; current: () => boolean; signal: AbortSignal;
  /** Lifetime payload reservations, including failed attempts; not wire-byte accounting. */
  maxBytes: number;
  /** Combined upload/download payload admitted in any rolling minute. Defaults to 1 MiB. */
  maxBytesPerMinute?: number;
}, transport: typeof fetch = fetch) {
  const endpoint = new URL(options.endpoint);
  const rate = options.maxBytesPerMinute ?? IPFS_MEDIA_BLOCK_BYTES;
  if (!Number.isSafeInteger(rate) || rate < 1 || rate > 8 * IPFS_MEDIA_BLOCK_BYTES) throw denied();
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash ||
      !Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > 64 * IPFS_MEDIA_BLOCK_BYTES) throw denied();
  const origin = endpoint.origin, current = options.current, signal = options.signal;
  let remaining = options.maxBytes, active = 0, attempts = 0, lastTime = -Infinity;
  const admitted: {at: number; bytes: number}[] = [];
  function check() { if (signal.aborted || !current()) throw denied(); }
  async function run<T>(size: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    check();
    if (!Number.isSafeInteger(size) || size < 1 || size > IPFS_MEDIA_BLOCK_BYTES || size > remaining || active >= 2 || attempts >= 128) throw denied();
    const at = performance.now();
    // Monotonic clock; fail closed on invalid/backwards time instead of replenishing quota.
    if (!Number.isFinite(at) || at < lastTime) throw denied();
    lastTime = at;
    while (admitted.length && at - admitted[0].at >= 60_000) admitted.shift();
    if (size > rate - admitted.reduce((sum, entry) => sum + entry.bytes, 0)) throw denied();
    admitted.push({at, bytes: size});
    remaining -= size; attempts++; active++;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal.addEventListener("abort", cancel, {once: true});
    let timer: ReturnType<typeof setTimeout>;
    const stopped = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(denied()), {once: true});
      timer = setTimeout(cancel, 10_000);
    });
    const pending = (async () => {
      try { check(); const result = await work(controller.signal); check(); if (controller.signal.aborted) throw denied(); return result; }
      finally { active--; }
    })();
    // Keep the slot occupied until even an abort-ignoring injected transport settles.
    try { return await Promise.race([pending, stopped]); }
    finally { clearTimeout(timer!); signal.removeEventListener("abort", cancel); }
  }
  async function request(path: string, signal: AbortSignal, max: number, body?: FormData) {
    check(); if (signal.aborted) throw denied();
    const response = await transport(origin + path, {method: "POST", body, signal, mode: "cors", credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer"});
    const reader = response.body?.getReader();
    if (!reader) throw denied();
    try {
      if (response.status !== 200 || response.redirected) throw denied();
      const buffer = new Uint8Array(max); let length = 0;
      while (true) {
        check(); if (signal.aborted) throw denied();
        const {value, done} = await reader.read(); if (done) break;
        if (value.length > max - length) throw denied();
        buffer.set(value, length); length += value.length;
      }
      return buffer.slice(0, length);
    } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  return Object.freeze({
    async put(block: Uint8Array): Promise<string> {
      if (!(block instanceof Uint8Array)) throw denied();
      return run(block.length, async signal => {
        const bytes = new Uint8Array(block);
        const cid = await rawMediaBlockCid(bytes);
        const body = new FormData(); body.append("file", new Blob([bytes]), "block");
        const reply = await request("/api/v0/block/put?cid-codec=raw&mhtype=sha2-256&mhlen=32&pin=false&allow-big-block=false", signal, 1024, body);
        const value = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(reply));
        if (!value || value.Key !== cid || value.Size !== bytes.length) throw denied();
        return cid;
      });
    },
    async get(cid: string, size: number): Promise<Uint8Array> {
      // Only the restricted raw CID family; the digest check below also enforces canonical encoding.
      if (typeof cid !== "string" || !/^bafkrei[a-z2-7]{52}$/.test(cid)) throw denied();
      return run(size, async signal => {
        const bytes = await request("/api/v0/block/get?arg=" + cid, signal, size);
        if (bytes.length !== size || await rawMediaBlockCid(bytes) !== cid) throw denied();
        return bytes;
      });
    },
  });
}
