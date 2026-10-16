/**
 * Encrypted backup of the Views store (docs/views.md §5).
 *
 * Each View version is encrypted on its own (AES-GCM-256, key derived by HKDF-SHA-256 from
 * the SEA pair's `epriv`) and addressed by the SHA-256 of its stored form. A per-device
 * manifest lists the current addresses and is signed with the SEA pair (ECDSA P-256,
 * the same primitives SEA uses). The same records and manifest are written to the
 * user's own graph space and can be exported as one file.
 */
import type { SeaPair } from "./identity/sea";
import { canonicalJson } from "./views-canonical";
import { defaultLock } from "./views-store";

export { canonicalJson };
import { CONFLICTS_MAX, countEntries, mergePrefs, ENTRIES_MAX, isLiveEntry, mergeVersionChecked, parseVersion, TOMBSTONES_MAX, VIEWS_MAX, type ViewsState, type ViewVersion } from "./views-store";
import { isSafeKey } from "./views-vv";
import type { Notice } from "./views-window";

export const BACKUP_FILE_KIND = "s3rch-views-backup";
export const BACKUP_FILE_MAX_BYTES = 5 * 1024 * 1024;
export const BACKUP_MAX_MANIFESTS = 16;
/** Writer-index entries looked up on restore while collecting BACKUP_MAX_MANIFESTS manifests. */
export const GRAPH_SCAN_MAX = 256;
/** Record lookups in flight at once during a restore. */
const FETCH_CONCURRENCY = 8;

/** Map with at most `limit` calls in flight; results keep input order. */
async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
/** Every version a state can hold: each entry × (current + CONFLICTS_MAX copies). */
export const BACKUP_MAX_ENTRIES = ENTRIES_MAX * (1 + CONFLICTS_MAX);
const HKDF_SALT = "s3rch-views-backup-v1";

export type EncryptedRecord = { v: 1; iv: string; ct: string };
export type ManifestEntry = { id: string; address: string };
/** `prefs` is the address of this writer's encrypted recents and favorites record. */
export type Manifest = { v: 1; owner: string; writerId: string; seq: number; entries: ManifestEntry[]; prefs?: string; sig: string };
export type BackupFile = { kind: typeof BACKUP_FILE_KIND; v: 1; manifests: Manifest[]; records: Record<string, EncryptedRecord> };

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64u(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64u(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("invalid base64url");
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function sha256Hex(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function recordAddress(record: EncryptedRecord): Promise<string> {
  return sha256Hex(canonicalJson(record));
}

function splitPub(pub: string): { x: string; y: string } {
  const [x, y, ...rest] = pub.split(".");
  if (!x || !y || rest.length) throw new Error("invalid SEA pub");
  return { x, y };
}

export async function deriveBackupKey(pair: Pick<SeaPair, "epriv">): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey("raw", fromB64u(pair.epriv), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode(HKDF_SALT), info: enc.encode("views-record") },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function signingKey(pair: Pick<SeaPair, "pub" | "priv">): Promise<CryptoKey> {
  const { x, y } = splitPub(pair.pub);
  return crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x, y, d: pair.priv, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

function verifyingKey(pub: string): Promise<CryptoKey> {
  const { x, y } = splitPub(pub);
  return crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x, y, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
}

/** Additional data binds a record to its owner and View id, so records cannot be swapped. */
function aad(owner: string, id: string): Uint8Array<ArrayBuffer> {
  return enc.encode(canonicalJson({ owner, id, purpose: "views-record" }));
}

function prefsAad(owner: string, writerId: string): Uint8Array<ArrayBuffer> {
  return enc.encode(canonicalJson({ owner, writerId, purpose: "views-prefs" }));
}

async function encryptBytes(key: CryptoKey, additionalData: Uint8Array<ArrayBuffer>, plaintext: string): Promise<EncryptedRecord> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData }, key, enc.encode(plaintext)));
  return { v: 1, iv: b64u(iv), ct: b64u(ct) };
}

async function decryptBytes(key: CryptoKey, additionalData: Uint8Array<ArrayBuffer>, record: EncryptedRecord): Promise<string | null> {
  try {
    const iv = fromB64u(record.iv);
    if (iv.length !== 12) return null;
    return dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData }, key, fromB64u(record.ct)));
  } catch {
    return null;
  }
}

export async function encryptVersion(key: CryptoKey, owner: string, version: ViewVersion): Promise<EncryptedRecord> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(owner, version.id) }, key, enc.encode(canonicalJson(version))),
  );
  return { v: 1, iv: b64u(iv), ct: b64u(ct) };
}

export async function decryptVersion(key: CryptoKey, owner: string, id: string, record: EncryptedRecord, notices: Notice[]): Promise<ViewVersion | null> {
  try {
    const iv = fromB64u(record.iv);
    if (iv.length !== 12) return null;
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad(owner, id) }, key, fromB64u(record.ct));
    const version = parseVersion(JSON.parse(dec.decode(pt)), notices);
    return version && version.id === id ? version : null;
  } catch {
    return null;
  }
}

function manifestBody(m: Omit<Manifest, "sig">): string {
  return canonicalJson({ v: m.v, owner: m.owner, writerId: m.writerId, seq: m.seq, entries: m.entries, prefs: m.prefs });
}

export async function signManifest(pair: Pick<SeaPair, "pub" | "priv">, m: Omit<Manifest, "sig">): Promise<Manifest> {
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await signingKey(pair), enc.encode(manifestBody(m))));
  return { ...m, sig: b64u(sig) };
}

export async function verifyManifest(pub: string, m: Manifest): Promise<boolean> {
  try {
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, await verifyingKey(pub), fromB64u(m.sig), enc.encode(manifestBody(m)));
  } catch {
    return false;
  }
}

/**
 * Build this device's backup: one encrypted record per current version and conflicting
 * copy (tombstones included), and a signed manifest. `seq` must increase on every write.
 */
/**
 * Local cache from a version's canonical plaintext digest to its stored record, so an
 * unchanged version keeps its ciphertext and address across backups. Never published.
 */
export type RecordCache = Map<string, { address: string; record: EncryptedRecord }>;

export async function buildBackup(
  state: ViewsState,
  pair: SeaPair,
  writerId: string,
  seq: number,
  cache: RecordCache = new Map(),
): Promise<{ manifest: Manifest; records: Record<string, EncryptedRecord> }> {
  if (!isSafeKey(writerId)) throw new Error("writerId is empty or reserved");
  if (!Number.isSafeInteger(seq) || seq < 0) throw new Error("seq must be a nonnegative safe integer");
  const key = await deriveBackupKey(pair);
  // Cache identities include the key pair, so a replaced pair never reuses old ciphertext.
  const keyId = await sha256Hex(`${pair.pub}\n${pair.epub}`);
  const records: Record<string, EncryptedRecord> = {};
  const entries: ManifestEntry[] = [];
  const used = new Set<string>();
  for (const entry of Object.values(state.views)) {
    for (const version of [entry.current, ...entry.conflicts]) {
      const digest = await sha256Hex(`${keyId}\n${state.owner}\n${canonicalJson(version)}`);
      let hit = cache.get(digest);
      if (!hit) {
        const record = await encryptVersion(key, state.owner, version);
        hit = { address: await recordAddress(record), record };
        cache.set(digest, hit);
      }
      used.add(digest);
      records[hit.address] = hit.record;
      entries.push({ id: version.id, address: hit.address });
    }
  }
  const prefsPlain = canonicalJson({ recents: state.recents, favorites: state.favorites, favoritesVV: state.favoritesVV });
  const prefsDigest = await sha256Hex(`${keyId}\n${state.owner}\n${writerId}\nprefs\n${prefsPlain}`);
  let prefsHit = cache.get(prefsDigest);
  if (!prefsHit) {
    const record = await encryptBytes(key, prefsAad(state.owner, writerId), prefsPlain);
    prefsHit = { address: await recordAddress(record), record };
    cache.set(prefsDigest, prefsHit);
  }
  used.add(prefsDigest);
  records[prefsHit.address] = prefsHit.record;
  for (const k of [...cache.keys()]) if (!used.has(k)) cache.delete(k);
  entries.sort((a, b) => (a.id + a.address < b.id + b.address ? -1 : 1));
  const manifest = await signManifest(pair, { v: 1, owner: state.owner, writerId, seq, entries, prefs: prefsHit.address });
  return { manifest, records };
}

function isRecordShape(value: unknown): value is EncryptedRecord {
  const r = value as EncryptedRecord;
  return typeof r === "object" && r !== null && r.v === 1 && typeof r.iv === "string" && typeof r.ct === "string" && Object.keys(r).length === 3;
}

function isManifestShape(value: unknown): value is Manifest {
  const m = value as Manifest;
  return (
    typeof m === "object" && m !== null && m.v === 1 && typeof m.owner === "string" && typeof m.writerId === "string" && isSafeKey(m.writerId) &&
    Number.isSafeInteger(m.seq) && m.seq >= 0 && typeof m.sig === "string" && Array.isArray(m.entries) && m.entries.length <= BACKUP_MAX_ENTRIES &&
    m.entries.every((e) => typeof e === "object" && e !== null && typeof e.id === "string" && isSafeKey(e.id) && typeof e.address === "string" && /^[0-9a-f]{64}$/.test(e.address)) &&
    (m.prefs === undefined || (typeof m.prefs === "string" && /^[0-9a-f]{64}$/.test(m.prefs)))
  );
}

/**
 * Merge verified backup manifests into local state. Every manifest must be signed by
 * `pair.pub` for this owner; every record must match its address and decrypt. Versions are
 * merged by version vector; concurrent ones become conflicting copies.
 */
export async function restoreBackup(
  state: ViewsState,
  pair: SeaPair,
  manifests: unknown[],
  fetchRecord: (address: string, writerId: string) => Promise<unknown>,
): Promise<{ state: ViewsState; notices: Notice[] }> {
  const notices: Notice[] = [];
  const key = await deriveBackupKey(pair);
  const views = { ...state.views };
  // Keep only the highest seq per writer.
  const latest = new Map<string, Manifest>();
  // Count only verified manifests toward the limit; look at a bounded number in total.
  let verified = 0;
  for (const m of manifests.slice(0, GRAPH_SCAN_MAX)) {
    if (verified >= BACKUP_MAX_MANIFESTS) break;
    if (!isManifestShape(m) || m.owner !== state.owner || !(await verifyManifest(pair.pub, m))) {
      notices.push({ message: "A backup manifest could not be verified and was skipped" });
      continue;
    }
    verified++;
    const prior = latest.get(m.writerId);
    if (!prior || m.seq > prior.seq) latest.set(m.writerId, m);
  }
  const prefsInputs: unknown[] = [];
  for (const m of latest.values()) {
    if (m.prefs) {
      let raw: unknown;
      try {
        raw = await fetchRecord(m.prefs, m.writerId);
      } catch {
        raw = undefined;
      }
      const text = isRecordShape(raw) && (await recordAddress(raw)) === m.prefs ? await decryptBytes(key, prefsAad(state.owner, m.writerId), raw) : null;
      let parsed: unknown = null;
      try {
        parsed = text === null ? null : JSON.parse(text);
      } catch {
        parsed = null;
      }
      if (parsed === null) notices.push({ message: "Saved recents and favorites from one device could not be read" });
      else prefsInputs.push(parsed);
    }
    // Fetch with bounded concurrency; merge below in manifest order.
    const fetched = await mapPool(m.entries, FETCH_CONCURRENCY, async (e) => {
      try {
        return await fetchRecord(e.address, m.writerId);
      } catch {
        return undefined;
      }
    });
    for (const [i, e] of m.entries.entries()) {
      const raw = fetched[i];
      if (!isRecordShape(raw) || (await recordAddress(raw)) !== e.address) {
        notices.push({ message: `Backup record for view ${e.id} is missing or altered` });
        continue;
      }
      const version = await decryptVersion(key, state.owner, e.id, raw, notices);
      if (!version) {
        notices.push({ message: `Backup record for view ${e.id} could not be decrypted` });
        continue;
      }
      const prior = Object.hasOwn(views, e.id) ? views[e.id] : undefined;
      const merged = mergeVersionChecked(prior, version);
      views[e.id] = merged.entry;
      if (merged.overflow) notices.push({ message: `View ${e.id} has more than ${CONFLICTS_MAX} conflicting copies; extra copies were dropped` });
    }
  }
  enforceLimits(state.views, views, notices);
  const prefsState = mergePrefs(state, prefsInputs);
  return { state: { ...state, views, recents: prefsState.recents, favorites: prefsState.favorites, favoritesVV: prefsState.favoritesVV }, notices };
}

/**
 * Apply the live and tombstone limits to the fully merged result, so tombstones in a later
 * manifest free slots before replacements are counted. Entries that would exceed a limit
 * fall back to their local version (or are left out), highest id first, with a notice.
 */
function enforceLimits(before: ViewsState["views"], after: ViewsState["views"], notices: Notice[]): void {

  // Changed entries, last id first; reverting all of them yields the local state, which was
  // within both limits, so this always terminates within the limits.
  const changed = Object.keys(after)
    .filter((id) => !Object.hasOwn(before, id) || before[id] !== after[id])
    .sort()
    .reverse();
  // Counted once, then updated as entries are reverted.
  const c = countEntries({ views: after } as ViewsState);
  const pending = new Set(changed);
  let progressed = true;
  while (progressed && (c.live > VIEWS_MAX || c.tombstones > TOMBSTONES_MAX)) {
    progressed = false;
    for (const id of changed) {
      if (!pending.has(id)) continue;
      if (c.live <= VIEWS_MAX && c.tombstones <= TOMBSTONES_MAX) break;
      const live = isLiveEntry(after[id]!);
      if ((live && c.live <= VIEWS_MAX) || (!live && c.tombstones <= TOMBSTONES_MAX)) continue;
      const old = Object.hasOwn(before, id) ? before[id]! : undefined;
      if (live) c.live--;
      else c.tombstones--;
      if (old) {
        after[id] = old;
        if (isLiveEntry(old)) c.live++;
        else c.tombstones++;
      } else delete after[id];
      pending.delete(id);
      progressed = true;
      notices.push({ message: `View limit reached; view ${id} was not restored` });
    }
  }
}

/** Serialize backups to one file. Fails rather than producing a file the importer would reject. */
export function exportBackupFile(parts: { manifest: Manifest; records: Record<string, EncryptedRecord> }[]): { ok: true; text: string } | { ok: false; error: string } {
  const file: BackupFile = { kind: BACKUP_FILE_KIND, v: 1, manifests: [], records: {} };
  for (const p of parts) {
    file.manifests.push(p.manifest);
    Object.assign(file.records, p.records);
  }
  if (file.manifests.length > BACKUP_MAX_MANIFESTS) return { ok: false, error: "too many writers for one file" };
  const text = JSON.stringify(file);
  if (enc.encode(text).length > BACKUP_FILE_MAX_BYTES) return { ok: false, error: "backup is larger than the file limit" };
  return { ok: true, text };
}

/** Parse an exported file. The size cap is checked before parsing. */
export function parseBackupFile(text: string): { ok: true; file: BackupFile } | { ok: false; error: string } {
  if (enc.encode(text).length > BACKUP_FILE_MAX_BYTES) return { ok: false, error: "backup file is too large" };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "backup file is not JSON" };
  }
  const f = raw as BackupFile;
  if (typeof f !== "object" || f === null || f.kind !== BACKUP_FILE_KIND || f.v !== 1 || !Array.isArray(f.manifests) || typeof f.records !== "object" || f.records === null) {
    return { ok: false, error: "not a Views backup file" };
  }
  return { ok: true, file: f };
}

/** Restore from an exported file. */
export async function restoreBackupFile(state: ViewsState, pair: SeaPair, text: string): Promise<{ state: ViewsState; notices: Notice[] }> {
  const parsed = parseBackupFile(text);
  if (!parsed.ok) return { state, notices: [{ message: parsed.error }] };
  const records = parsed.file.records;
  return restoreBackup(state, pair, parsed.file.manifests, async (a) => (Object.prototype.hasOwnProperty.call(records, a) ? records[a] : undefined));
}

/* ---------- user graph copy ---------- */

/** Minimal chain interface of an authenticated Gun user (`gun.user()`), so tests can use a fake. */
export type GraphChain = {
  get(key: string): GraphChain;
  put(value: string | null, cb?: (ack: { err?: string }) => void): unknown;
  once(cb: (value: unknown) => void): unknown;
};

function putString(chain: GraphChain, value: string | null): Promise<void> {
  return new Promise((resolve, reject) => {
    chain.put(value, (ack) => (ack?.err ? reject(new Error(ack.err)) : resolve()));
  });
}

function readString(chain: GraphChain): Promise<unknown> {
  return new Promise((resolve) => chain.once((v) => resolve(typeof v === "string" ? safeParse(v) : undefined)));
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Write records, then the manifest, below the user's own space:
 * `~<pub>/s3rch-views-records/<writerId>/<address>` and `~<pub>/s3rch-views/<writerId>`.
 * The manifest is written last so it never names a record that is not stored yet.
 *
 * Reclamation is a sweep, not a queue: records live in a per-writer namespace, so after each
 * call every record in that namespace that the published manifest does not name is removed.
 * Leftovers from any earlier failure (a failed manifest write, a failed delete, a crash) are
 * found by the next sweep without tracking them.
 */
export async function writeBackupToGraph(
  user: GraphChain,
  backup: { manifest: Manifest; records: Record<string, EncryptedRecord> },
  opts: { pub: string; lock?: <T>(name: string, run: () => Promise<T>) => Promise<T>; now?: () => number },
): Promise<"written" | "stale"> {
  const { manifest } = backup;
  const lock = opts.lock ?? defaultLock();
  const now = opts.now ?? Date.now;
  // Publish only what restore accepts: valid shape and a signature by this user's key.
  if (!isManifestShape(manifest) || !(await verifyManifest(opts.pub, manifest))) throw new Error("manifest is invalid");
  // Every address the manifest names must be supplied and match its content address.
  for (const address of addressesOf(manifest)) {
    const record = Object.hasOwn(backup.records, address) ? backup.records[address] : undefined;
    if (!isRecordShape(record) || (await recordAddress(record)) !== address) throw new Error("backup is missing or has altered records");
  }
  // Serialized per writer across tabs; a lower or equal seq never replaces a published manifest.
  return lock(`s3rch-views-backup:${manifest.owner}:${manifest.writerId}`, async () => {
    const slot = user.get("s3rch-views").get(manifest.writerId);
    const existing = await readString(slot);
    // Only a verified manifest for this owner and writer can make a publication stale.
    const prior =
      isManifestShape(existing) && existing.owner === manifest.owner && existing.writerId === manifest.writerId && (await verifyManifest(opts.pub, existing))
        ? existing
        : null;
    const index = user.get("s3rch-views-writers").get(manifest.writerId);
    const recordsOf = user.get("s3rch-views-records").get(manifest.writerId);
    // An identical manifest is republished in full (records verified and repaired, index
    // refreshed); any other manifest at a lower or equal seq is stale.
    // Signatures are randomized, so compare the signed bodies; both are verified at this point.
    const sameAsPublished = prior !== null && manifestBody(prior) === manifestBody(manifest);
    if (prior && prior.seq >= manifest.seq && !sameAsPublished) {
      await sweepRecords(recordsOf, addressesOf(prior));
      return "stale";
    }
    const known = new Set(prior ? addressesOf(prior) : []);
    for (const [address, record] of Object.entries(backup.records)) {
      // Rewrite a known record if it is no longer readable (for example, lost by partial retention).
      if (known.has(address)) {
        const stored = await readString(recordsOf.get(address));
        if (isRecordShape(stored) && (await recordAddress(stored)) === address) continue;
      }
      await putString(recordsOf.get(address), JSON.stringify(record));
    }
    await putString(slot, JSON.stringify(manifest));
    // Writer index in the user's own space, so a new device can find earlier writers.
    // The value is the publication time, used only to pick the most recent writers on restore.
    await putString(index, String(now()));
    await sweepRecords(recordsOf, addressesOf(manifest));
    return "written";
  });
}

function addressesOf(m: Manifest): string[] {
  return [...m.entries.map((e) => e.address), ...(m.prefs ? [m.prefs] : [])];
}

/** Remove every stored record in a writer's namespace that `keep` does not name. Best effort. */
async function sweepRecords(recordsOf: GraphChain, keep: string[]): Promise<void> {
  const keepSet = new Set(keep);
  const node = await new Promise<unknown>((resolve) => recordsOf.once(resolve));
  if (typeof node !== "object" || node === null) return;
  for (const [address, value] of Object.entries(node as Record<string, unknown>)) {
    if (address === "_" || value === null || value === undefined || keepSet.has(address)) continue;
    try {
      await putString(recordsOf.get(address), null);
    } catch {
      /* found again by the next sweep */
    }
  }
}

function isIndexValue(v: unknown): boolean {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

/**
 * Writer ids from the user's writer index (`~<pub>/s3rch-views-writers`), most recently
 * published first. The order only decides which writers are read first on restore.
 */
export function listGraphWriters(user: GraphChain): Promise<string[]> {
  return new Promise((resolve) =>
    user.get("s3rch-views-writers").once((node) => {
      if (typeof node !== "object" || node === null) return resolve([]);
      const rows: [string, number][] = [];
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        const at = typeof v === "string" && /^[0-9]{1,16}$/.test(v) ? Number(v) : NaN;
        if (k !== "_" && isSafeKey(k) && isIndexValue(at)) rows.push([k, at]);
      }
      rows.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
      resolve(rows.map(([k]) => k));
    }),
  );
}

/**
 * Restore from the user's graph copy. Without explicit writer ids, the writer index is
 * read; manifests are still verified, so a bogus index entry only costs one lookup.
 */
export async function restoreFromGraph(state: ViewsState, pair: SeaPair, user: GraphChain, writerIds?: string[]): Promise<{ state: ViewsState; notices: Notice[] }> {
  const manifests: unknown[] = [];
  const ids = writerIds ?? (await listGraphWriters(user));
  // Skip entries whose manifest is gone or invalid, so they do not use up the manifest limit.
  for (const w of ids.slice(0, GRAPH_SCAN_MAX)) {
    if (manifests.length >= BACKUP_MAX_MANIFESTS) break;
    const m = await readString(user.get("s3rch-views").get(w));
    if (isManifestShape(m) && m.owner === state.owner && m.writerId === w && (await verifyManifest(pair.pub, m))) manifests.push(m);
  }
  return restoreBackup(state, pair, manifests, (a, w) => readString(user.get("s3rch-views-records").get(w).get(a)));
}
