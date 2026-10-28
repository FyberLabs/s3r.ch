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
import { adoptRetirements, applyDropped, CONFLICTS_MAX, countEntries, emptyState, expandState, mergePrefs, ENTRIES_MAX, isLiveEntry, mergeVersionChecked, parseVersionPayload, TOMBSTONES_MAX, VIEWS_MAX, type ViewEntry, type ViewsState, type ViewVersion } from "./views-store";
import { coversCausal, expandFolded, isSafeKey, isVersionVector, maxCausal, readCausal, unionRetirements, type Causal, type VersionVector } from "./views-vv";
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
export type Manifest = {
  v: 1;
  owner: string;
  writerId: string;
  seq: number;
  /** Device whose component this writer advances. Retired with the writer. */
  deviceId?: string;
  entries: ManifestEntry[];
  prefs?: string;
  /** Signed account retirement map: deviceId → final counter. */
  retirements?: VersionVector;
  sig: string;
};

/** A removal intent for one publication slot. The slot is not written again while this exists. */
export type WriterTombstone = {
  v: 1;
  owner: string;
  writerId: string;
  seq: number;
  manifestHash: string;
  deviceId?: string;
  counter: number;
  sig: string;
};
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

export async function encryptVersion(key: CryptoKey, owner: string, version: ViewVersion, hidden?: Causal[]): Promise<EncryptedRecord> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload = hidden?.length ? { ...version, hidden } : version;
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(owner, version.id) }, key, enc.encode(canonicalJson(payload))),
  );
  return { v: 1, iv: b64u(iv), ct: b64u(ct) };
}

export async function decryptVersion(
  key: CryptoKey,
  owner: string,
  id: string,
  record: EncryptedRecord,
  notices: Notice[],
): Promise<{ version: ViewVersion; hidden?: Causal[] } | null> {
  try {
    const iv = fromB64u(record.iv);
    if (iv.length !== 12) return null;
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad(owner, id) }, key, fromB64u(record.ct));
    const parsed = parseVersionPayload(JSON.parse(dec.decode(pt)), notices);
    return parsed && parsed.version.id === id ? parsed : null;
  } catch {
    return null;
  }
}

function manifestBody(m: Omit<Manifest, "sig">): string {
  return canonicalJson({
    v: m.v,
    owner: m.owner,
    writerId: m.writerId,
    seq: m.seq,
    deviceId: m.deviceId,
    entries: m.entries,
    prefs: m.prefs,
    retirements: m.retirements && Object.keys(m.retirements).length ? m.retirements : undefined,
  });
}

function tombstoneBody(t: Omit<WriterTombstone, "sig">): string {
  return canonicalJson({ v: t.v, owner: t.owner, writerId: t.writerId, seq: t.seq, manifestHash: t.manifestHash, deviceId: t.deviceId, counter: t.counter });
}

async function signText(pair: Pick<SeaPair, "pub" | "priv">, text: string): Promise<string> {
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await signingKey(pair), enc.encode(text)));
  return b64u(sig);
}

async function verifyText(pub: string, text: string, sig: string): Promise<boolean> {
  try {
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, await verifyingKey(pub), fromB64u(sig), enc.encode(text));
  } catch {
    return false;
  }
}

export async function signManifest(pair: Pick<SeaPair, "pub" | "priv">, m: Omit<Manifest, "sig">): Promise<Manifest> {
  return { ...m, sig: await signText(pair, manifestBody(m)) };
}

export async function verifyManifest(pub: string, m: Manifest): Promise<boolean> {
  return verifyText(pub, manifestBody(m), m.sig);
}

export async function signWriterTombstone(pair: Pick<SeaPair, "pub" | "priv">, t: Omit<WriterTombstone, "sig">): Promise<WriterTombstone> {
  return { ...t, sig: await signText(pair, tombstoneBody(t)) };
}

export async function verifyWriterTombstone(pub: string, t: WriterTombstone): Promise<boolean> {
  return verifyText(pub, tombstoneBody(t), t.sig);
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
      const payload = entry.hidden?.length ? { ...version, hidden: entry.hidden } : version;
      const digest = await sha256Hex(`${keyId}\n${state.owner}\n${canonicalJson(payload)}`);
      let hit = cache.get(digest);
      if (!hit) {
        const record = await encryptVersion(key, state.owner, version, entry.hidden);
        hit = { address: await recordAddress(record), record };
        cache.set(digest, hit);
      }
      used.add(digest);
      records[hit.address] = hit.record;
      entries.push({ id: version.id, address: hit.address });
    }
  }
  const prefsPlain = canonicalJson({
    recents: state.recents,
    favorites: state.favorites,
    favoritesVV: state.favoritesVV,
    favoritesFolded: state.favoritesFolded,
    favoritesFoldedAll: state.favoritesFoldedAll,
    dropped: Object.keys(state.dropped).length ? state.dropped : undefined,
  });
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
  const retirements = Object.keys(state.retirements).length ? state.retirements : undefined;
  const manifest = await signManifest(pair, { v: 1, owner: state.owner, writerId, deviceId: state.deviceId, seq, entries, prefs: prefsHit.address, retirements });
  return { manifest, records };
}

function isRecordShape(value: unknown): value is EncryptedRecord {
  const r = value as EncryptedRecord;
  return typeof r === "object" && r !== null && r.v === 1 && typeof r.iv === "string" && typeof r.ct === "string" && Object.keys(r).length === 3;
}

const RETIREMENTS_KEYS_MAX = 4096;

function isManifestShape(value: unknown): value is Manifest {
  const m = value as Manifest;
  return (
    typeof m === "object" && m !== null && m.v === 1 && typeof m.owner === "string" && typeof m.writerId === "string" && isSafeKey(m.writerId) &&
    (m.deviceId === undefined || (typeof m.deviceId === "string" && isSafeKey(m.deviceId))) &&
    Number.isSafeInteger(m.seq) && m.seq >= 0 && typeof m.sig === "string" && Array.isArray(m.entries) && m.entries.length <= BACKUP_MAX_ENTRIES &&
    m.entries.every((e) => typeof e === "object" && e !== null && typeof e.id === "string" && isSafeKey(e.id) && typeof e.address === "string" && /^[0-9a-f]{64}$/.test(e.address)) &&
    (m.prefs === undefined || (typeof m.prefs === "string" && /^[0-9a-f]{64}$/.test(m.prefs))) &&
    (m.retirements === undefined || (isVersionVector(m.retirements) && Object.keys(m.retirements).length <= RETIREMENTS_KEYS_MAX))
  );
}

function isTombstoneShape(value: unknown): value is WriterTombstone {
  const t = value as WriterTombstone;
  return (
    typeof t === "object" && t !== null && t.v === 1 && typeof t.owner === "string" && typeof t.writerId === "string" && isSafeKey(t.writerId) &&
    Number.isSafeInteger(t.seq) && t.seq >= 0 && typeof t.manifestHash === "string" && /^[0-9a-f]{64}$/.test(t.manifestHash) &&
    (t.deviceId === undefined || (typeof t.deviceId === "string" && isSafeKey(t.deviceId))) &&
    Number.isSafeInteger(t.counter) && t.counter >= 0 && typeof t.sig === "string"
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expandVersion(v: ViewVersion, map: VersionVector): ViewVersion {
  const c = expandFolded({ vv: v.vv, folded: v.folded, foldedAll: v.foldedAll }, map);
  const out: ViewVersion = v.deleted ? { id: v.id, vv: c.vv, deleted: true } : { id: v.id, vv: c.vv, view: v.view };
  if (c.folded && Object.keys(c.folded).length) out.folded = c.folded;
  return out;
}

function entryStamp(entry: ViewEntry): Causal {
  return maxCausal(
    { vv: entry.current.vv, folded: entry.current.folded },
    ...entry.conflicts.map((v) => ({ vv: v.vv, folded: v.folded })),
    ...(entry.hidden ?? []),
  );
}

/**
 * Merge verified backup manifests into local state. Every manifest must be signed by
 * `pair.pub` for this owner; every record must match its address and decrypt. Versions are
 * merged by their own folded counters before any incoming retirement map is adopted, so a
 * stamp that never saw a device keeps reading it as 0. Conflicting copies past the cap
 * leave a joined causal summary; their kept set does not depend on manifest order.
 */
export async function restoreBackup(
  state: ViewsState,
  pair: SeaPair,
  manifests: unknown[],
  fetchRecord: (address: string, writerId: string) => Promise<unknown>,
): Promise<{ state: ViewsState; notices: Notice[] }> {
  const notices: Notice[] = [];
  const key = await deriveBackupKey(pair);
  // Expand against the map these stamps were saved with, before incoming retirements exist.
  const base = expandState(state);
  const views = { ...base.views };
  // Keep only the highest seq per writer.
  const latest = new Map<string, Manifest>();
  // Count distinct verified writers toward the limit; look at a bounded number in total.
  for (const m of manifests.slice(0, GRAPH_SCAN_MAX)) {
    if (!isManifestShape(m) || m.owner !== state.owner || !(await verifyManifest(pair.pub, m))) {
      notices.push({ message: "A backup manifest could not be verified and was skipped" });
      continue;
    }
    const prior = latest.get(m.writerId);
    if (!prior && latest.size >= BACKUP_MAX_MANIFESTS) continue;
    if (!prior || m.seq > prior.seq) latest.set(m.writerId, m);
  }
  const prefsInputs: unknown[] = [];
  const incoming = new Map<string, { version: ViewVersion; hidden?: Causal[] }[]>();
  const retirementMaps: VersionVector[] = [];
  for (const m of latest.values()) {
    if (m.retirements && Object.keys(m.retirements).length) retirementMaps.push(m.retirements);
    const map = m.retirements ?? {};
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
      else prefsInputs.push(isPlainRecord(parsed) ? { ...parsed, retirements: m.retirements } : { retirements: m.retirements });
    }
    // Fetch with bounded concurrency. Merge after every manifest is loaded, in canonical
    // order, so a cap does not depend on which manifest arrived first.
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
      const parsed = await decryptVersion(key, state.owner, e.id, raw, notices);
      if (!parsed) {
        notices.push({ message: `Backup record for view ${e.id} could not be decrypted` });
        continue;
      }
      const version = expandVersion(parsed.version, map);
      const hidden = parsed.hidden?.map((h) => expandFolded(h, map));
      const list = incoming.get(version.id) ?? [];
      list.push({ version, hidden });
      incoming.set(version.id, list);
    }
  }
  const prefsState = mergePrefs(base, prefsInputs);
  const dropped: ViewsState["dropped"] = { ...prefsState.dropped };
  const ids = [...incoming.keys()].sort();
  for (const id of ids) {
    const list = incoming.get(id)!;
    list.sort((a, b) => (canonicalJson(a.version) < canonicalJson(b.version) ? -1 : canonicalJson(a.version) > canonicalJson(b.version) ? 1 : 0));
    for (const item of list) {
      const cover = Object.hasOwn(dropped, id) ? dropped[id] : undefined;
      if (cover && coversCausal(cover, { vv: item.version.vv, folded: item.version.folded })) continue;
      const prior = Object.hasOwn(views, id) ? views[id] : undefined;
      const merged = mergeVersionChecked(prior, item.version, item.hidden);
      views[id] = merged.entry;
      if (merged.overflow) notices.push({ message: `View ${id} has more than ${CONFLICTS_MAX} conflicting copies; extra copies were dropped` });
    }
  }
  // Deletion summaries free slots before the live and tombstone caps are applied. Summaries
  // created while enforcing those caps are applied afterwards.
  const prepared = applyDropped({ ...prefsState, views, dropped });
  enforceLimits(base.views, prepared.views, notices, prepared.dropped);
  const merged = applyDropped(prepared);
  // Retirements are adopted only after versions have been merged on their own stamps.
  return { state: adoptRetirements(merged, unionRetirements(retirementMaps)), notices };
}

/**
 * Apply the live and tombstone limits to the fully merged result, so tombstones in a later
 * manifest free slots before replacements are counted. Entries that would exceed a limit
 * fall back to their local version (or are left out), highest id first, with a notice.
 */
function enforceLimits(before: ViewsState["views"], after: ViewsState["views"], notices: Notice[], dropped: ViewsState["dropped"]): void {
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
      const entry = after[id]!;
      const live = isLiveEntry(entry);
      if ((live && c.live <= VIEWS_MAX) || (!live && c.tombstones <= TOMBSTONES_MAX)) continue;
      if (!live) dropped[id] = maxCausal(Object.hasOwn(dropped, id) ? dropped[id] : undefined, entryStamp(entry));
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

/** Index and tombstone key for one publication. The sequence number is never reused after a tombstone. */
export function writerSlotKey(writerId: string, seq: number): string {
  return `${String(writerId.length)}:${writerId}:${String(seq)}`;
}

export function parseWriterSlot(key: string): { writerId: string; seq: number } | null {
  const first = key.indexOf(":");
  if (first <= 0) return null;
  const len = Number(key.slice(0, first));
  if (!Number.isInteger(len) || len <= 0) return null;
  const rest = key.slice(first + 1);
  if (!isSafeKey(rest.slice(0, len)) || rest.charAt(len) !== ":") return null;
  const seqText = rest.slice(len + 1);
  if (!/^[0-9]+$/.test(seqText)) return null;
  const seq = Number(seqText);
  if (!Number.isSafeInteger(seq)) return null;
  return { writerId: rest.slice(0, len), seq };
}

type Publication = { seq: number; manifest: Manifest; legacy: boolean };

function readNode(chain: GraphChain): Promise<unknown> {
  return new Promise((resolve) => chain.once(resolve));
}

/** Publications under `s3rch-views/<writerId>/<seq>`, plus a legacy manifest stored at the writer node. */
async function publicationsOf(user: GraphChain, writerId: string, pub: string): Promise<Publication[]> {
  const node = await readNode(user.get("s3rch-views").get(writerId));
  const out: Publication[] = [];
  const consider = async (seq: number, value: unknown) => {
    const manifest = typeof value === "string" ? safeParse(value) : value;
    if (!isManifestShape(manifest) || manifest.owner === undefined) return;
    if (manifest.writerId !== writerId || manifest.seq !== seq || !(await verifyManifest(pub, manifest))) return;
    out.push({ seq, manifest, legacy: false });
  };
  if (typeof node === "string") {
    const manifest = safeParse(node);
    if (isManifestShape(manifest) && manifest.writerId === writerId && (await verifyManifest(pub, manifest))) out.push({ seq: manifest.seq, manifest, legacy: true });
    return out;
  }
  if (typeof node === "object" && node !== null) {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "_" || v == null || !/^[0-9]+$/.test(k)) continue;
      await consider(Number(k), v);
    }
  }
  return out;
}

function highestPub(pubs: Publication[]): Publication | null {
  return pubs.reduce<Publication | null>((best, p) => (!best || p.seq > best.seq ? p : best), null);
}

/**
 * Write records, then the manifest, below the user's own space. Each sequence lives at
 * `~<pub>/s3rch-views/<writerId>/<seq>` and is not replaced with a different body. A
 * tombstone for that slot refuses another write. The manifest is written after its records.
 *
 * Reclamation is a sweep, not a queue: records live in a per-writer namespace, so after each
 * call every record in that namespace that the published manifest does not name is removed.
 * Older sequence slots of this same writer are removed after the new one is stored.
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
  // One publication of this writer at a time. A lower sequence never replaces a higher one,
  // even when the older slot still holds the same body.
  return lock(writerQueue(manifest.owner, manifest.writerId), async () => {
    const retired = await loadTombstones(user, opts.pub);
    if (retired.some((t) => t.owner === manifest.owner && t.writerId === manifest.writerId && t.seq === manifest.seq)) return "stale";
    const pubs = await publicationsOf(user, manifest.writerId, opts.pub);
    const sameSeq = pubs.find((p) => p.seq === manifest.seq) ?? null;
    const head = highestPub(pubs);
    const recordsOf = user.get("s3rch-views-records").get(manifest.writerId);
    const sameAsPublished = sameSeq !== null && manifestBody(sameSeq.manifest) === manifestBody(manifest);
    if (head && head.seq > manifest.seq) {
      await sweepRecords(recordsOf, addressesOf(head.manifest));
      if (sameSeq && sameAsPublished) {
        try {
          await deletePublication(user, manifest.writerId, sameSeq);
        } catch {
          /* a later publication of the newer head removes the slot */
        }
      }
      return "stale";
    }
    // A different body never replaces an existing sequence slot.
    if (sameSeq && !sameAsPublished) {
      await sweepRecords(recordsOf, addressesOf(sameSeq.manifest));
      return "stale";
    }
    const prior = sameAsPublished ? sameSeq.manifest : null;
    const known = new Set(prior ? addressesOf(prior) : []);
    for (const [address, record] of Object.entries(backup.records)) {
      // Rewrite a known record if it is no longer readable (for example, lost by partial retention).
      if (known.has(address)) {
        const stored = await readString(recordsOf.get(address));
        if (isRecordShape(stored) && (await recordAddress(stored)) === address) continue;
      }
      await putString(recordsOf.get(address), JSON.stringify(record));
    }
    const parent = user.get("s3rch-views").get(manifest.writerId);
    const legacy = await readNode(parent);
    if (typeof legacy === "string") {
      const parsed = safeParse(legacy);
      if (!isManifestShape(parsed) || !((await verifyManifest(opts.pub, parsed)) && parsed.seq > manifest.seq)) {
        try {
          await putString(parent, null);
        } catch {
          /* a later publish tries again; the sequence slot is still written */
        }
      }
    }
    await putString(parent.get(String(manifest.seq)), JSON.stringify(manifest));
    // Writer index in the user's own space, so a new device can find earlier writers.
    // The value is the publication time, used only to pick the most recent writers on restore.
    // One key per sequence, so removing an old sequence cannot clear a newer one.
    await putString(user.get("s3rch-views-writers").get(writerSlotKey(manifest.writerId, manifest.seq)), String(now()));
    await sweepRecords(recordsOf, addressesOf(manifest));
    for (const p of pubs) {
      if (p.seq >= manifest.seq) continue;
      try {
        await deletePublication(user, manifest.writerId, p);
      } catch {
        /* the next publish of this writer removes the slot again */
      }
    }
    return "written";
  });
}

function writerQueue(owner: string, writerId: string): string {
  return `s3rch-views-backup:${owner}:${writerId}`;
}

/** Remove one stored publication at the graph path it actually occupies. */
async function deletePublication(user: GraphChain, writerId: string, pub: Publication): Promise<void> {
  const parent = user.get("s3rch-views").get(writerId);
  if (pub.legacy) await putString(parent, null);
  else await putString(parent.get(String(pub.seq)), null);
  const indexKey = pub.legacy ? writerId : writerSlotKey(writerId, pub.seq);
  await putString(user.get("s3rch-views-writers").get(indexKey), null);
}

function addressesOf(m: Manifest): string[] {
  return [...m.entries.map((e) => e.address), ...(m.prefs ? [m.prefs] : [])];
}

/** Remove records `keep` does not name. False when any unreferenced record is still stored. */
async function sweepRecords(recordsOf: GraphChain, keep: string[]): Promise<boolean> {
  const keepSet = new Set(keep);
  const node = await new Promise<unknown>((resolve) => recordsOf.once(resolve));
  if (typeof node !== "object" || node === null) return true;
  let ok = true;
  for (const [address, value] of Object.entries(node as Record<string, unknown>)) {
    if (address === "_" || value === null || value === undefined || keepSet.has(address)) continue;
    try {
      await putString(recordsOf.get(address), null);
    } catch {
      ok = false;
    }
  }
  return ok && !(await strayRecords(recordsOf, keepSet));
}

async function strayRecords(recordsOf: GraphChain, keep: Set<string>): Promise<boolean> {
  const node = await new Promise<unknown>((resolve) => recordsOf.once(resolve));
  if (typeof node !== "object" || node === null) return false;
  return Object.entries(node as Record<string, unknown>).some(([address, value]) => address !== "_" && value !== null && value !== undefined && !keep.has(address));
}

function isIndexValue(v: unknown): boolean {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

/**
 * Writer ids from the user's writer index (`~<pub>/s3rch-views-writers`), most recently
 * published first. The order only decides which writers are read first on restore.
 * New entries are one key per sequence (`length:writerId:seq`); a bare writer id is legacy.
 */
export function listGraphWriters(user: GraphChain): Promise<string[]> {
  return new Promise((resolve) =>
    user.get("s3rch-views-writers").once((node) => {
      if (typeof node !== "object" || node === null) return resolve([]);
      const best = new Map<string, number>();
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        const at = typeof v === "string" && /^[0-9]{1,16}$/.test(v) ? Number(v) : NaN;
        if (k === "_" || !isIndexValue(at)) continue;
        const slot = parseWriterSlot(k);
        const writerId = slot?.writerId ?? (isSafeKey(k) ? k : "");
        if (!writerId) continue;
        const prev = best.get(writerId);
        if (prev === undefined || at > prev) best.set(writerId, at);
      }
      const rows = [...best.entries()];
      rows.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
      resolve(rows.map(([k]) => k));
    }),
  );
}

async function loadTombstones(user: GraphChain, pub: string): Promise<WriterTombstone[]> {
  const node = await readNode(user.get("s3rch-views-retired"));
  if (typeof node !== "object" || node === null) return [];
  const out: WriterTombstone[] = [];
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === "_" || v == null) continue;
    const parsed = typeof v === "string" ? safeParse(v) : v;
    if (!isTombstoneShape(parsed) || writerSlotKey(parsed.writerId, parsed.seq) !== k) continue;
    if (await verifyWriterTombstone(pub, parsed)) out.push(parsed);
  }
  return out;
}

/**
 * Delete a tombstoned slot, then records nothing live still names, then the tombstone.
 * The caller runs this in the writer's publication queue. A leftover record keeps the tombstone.
 */
async function finishTombstoneBody(user: GraphChain, t: WriterTombstone, pub: string): Promise<boolean> {
  const recordsOf = user.get("s3rch-views-records").get(t.writerId);
  const tomb = user.get("s3rch-views-retired").get(writerSlotKey(t.writerId, t.seq));
  try {
    const pubs = await publicationsOf(user, t.writerId, pub);
    const current = pubs.find((p) => p.seq === t.seq);
    if (current && (await sha256Hex(manifestBody(current.manifest))) !== t.manifestHash) {
      // The slot holds a different publication than the one named here. Leave it in place.
      await putString(tomb, null);
      return true;
    }
    if (current) await deletePublication(user, t.writerId, current);
    else {
      await putString(user.get("s3rch-views-writers").get(t.writerId), null);
      await putString(user.get("s3rch-views-writers").get(writerSlotKey(t.writerId, t.seq)), null);
    }
    if ((await publicationsOf(user, t.writerId, pub)).some((p) => p.seq === t.seq)) return false;
    const remaining = (await publicationsOf(user, t.writerId, pub)).filter((p) => p.seq !== t.seq);
    const keep = remaining.flatMap((p) => addressesOf(p.manifest));
    if (!(await sweepRecords(recordsOf, keep))) return false;
    await putString(tomb, null);
    return true;
  } catch {
    return false;
  }
}

type PublishLock = <T>(name: string, run: () => Promise<T>) => Promise<T>;

/** Finish removals that already have a tombstone, including ones whose first attempt failed. */
export async function retryWriterTombstones(
  user: GraphChain,
  pair: Pick<SeaPair, "pub" | "priv">,
  pub = pair.pub,
  lock: PublishLock = defaultLock(),
): Promise<{ pending: string[] }> {
  const pending: string[] = [];
  for (const t of await loadTombstones(user, pub)) {
    const done = await lock(writerQueue(t.owner, t.writerId), () => finishTombstoneBody(user, t, pub));
    if (!done) pending.push(writerSlotKey(t.writerId, t.seq));
  }
  return { pending };
}

function favStamp(s: ViewsState): Causal {
  return expandFolded({ vv: s.favoritesVV, folded: s.favoritesFolded, foldedAll: s.favoritesFoldedAll }, s.retirements);
}

function coveredBy(have: ViewsState, id: string, need: Causal): boolean {
  const dropped = Object.hasOwn(have.dropped, id) ? have.dropped[id] : undefined;
  if (dropped && coversCausal(dropped, need)) return true;
  const entry = Object.hasOwn(have.views, id) ? have.views[id] : undefined;
  if (!entry) return false;
  if ((entry.hidden ?? []).some((h) => coversCausal(h, need))) return true;
  return [entry.current, ...entry.conflicts].some((v) => coversCausal({ vv: v.vv, folded: v.folded }, need));
}

/** Every version, deletion summary and favorites stamp in `need` is covered by `have`. */
function containsState(have: ViewsState, need: ViewsState): boolean {
  const a = expandState(have);
  const b = expandState(need);
  if (!coversCausal(favStamp(a), favStamp(b))) return false;
  for (const [id, entry] of Object.entries(b.views)) {
    for (const version of [entry.current, ...entry.conflicts]) {
      if (!coveredBy(a, id, { vv: version.vv, folded: version.folded })) return false;
    }
    if ((entry.hidden ?? []).some((h) => !coveredBy(a, id, h))) return false;
  }
  for (const [id, causal] of Object.entries(b.dropped)) {
    if (!coveredBy(a, id, causal)) return false;
  }
  return true;
}

function highWater(state: ViewsState, deviceId: string): number {
  const s = expandState(state);
  let n = Object.hasOwn(s.retirements, deviceId) ? s.retirements[deviceId]! : 0;
  const consider = (c?: Causal) => {
    if (c) n = Math.max(n, readCausal(c, deviceId));
  };
  consider(favStamp(s));
  for (const entry of Object.values(s.views)) {
    consider({ vv: entry.current.vv, folded: entry.current.folded });
    for (const v of entry.conflicts) consider({ vv: v.vv, folded: v.folded });
    for (const h of entry.hidden ?? []) consider(h);
  }
  for (const c of Object.values(s.dropped)) consider(c);
  return n;
}

async function loadWriter(pair: SeaPair, user: GraphChain, manifest: Manifest): Promise<{ state: ViewsState; notices: Notice[] }> {
  const deviceId = manifest.deviceId && isSafeKey(manifest.deviceId) ? manifest.deviceId : "reader";
  return restoreBackup(emptyState(manifest.owner, deviceId), pair, [manifest], (a, w) => readString(user.get("s3rch-views-records").get(w).get(a)));
}

async function planRetirements(user: GraphChain, pair: SeaPair, state: ViewsState, publishingWriterId: string): Promise<VersionVector> {
  const planned: VersionVector = {};
  const writers = await listGraphWriters(user);
  for (const writerId of writers.slice(0, GRAPH_SCAN_MAX)) {
    // This publication's own earlier slots are the same device and are not a retirement.
    if (writerId === publishingWriterId) continue;
    const head = highestPub(await publicationsOf(user, writerId, pair.pub));
    if (!head?.manifest.deviceId || head.manifest.deviceId === state.deviceId) continue;
    const loaded = await loadWriter(pair, user, head.manifest);
    if (loaded.notices.length || !containsState(state, loaded.state)) continue;
    const deviceId = head.manifest.deviceId;
    const counter = Math.max(highWater(loaded.state, deviceId), highWater(state, deviceId));
    if (counter > 0) planned[deviceId] = Math.max(planned[deviceId] ?? 0, counter);
  }
  return planned;
}

/**
 * Tombstone and remove writers whose whole state is already in `survivor`, which must be
 * the manifest just published (its retirement map has to name each removed device). A
 * sequence slot is deleted only when it still holds the body named by its tombstone, so a
 * manifest published at a new sequence while this runs is left in place.
 */
/** Lesser writer id wins when two publications contain each other, so both can be pruned without emptying the graph. */
function survivorWins(survivor: Manifest, other: Publication): boolean {
  if (survivor.writerId !== other.manifest.writerId) return survivor.writerId < other.manifest.writerId;
  return survivor.seq >= other.seq;
}

export async function pruneSupersededWriters(
  user: GraphChain,
  pair: SeaPair,
  survivor: Manifest,
  pub = pair.pub,
  lock: PublishLock = defaultLock(),
): Promise<{ removed: string[]; pending: string[] }> {
  const pending = (await retryWriterTombstones(user, pair, pub, lock)).pending;
  const removed: string[] = [];
  if (!isManifestShape(survivor) || !(await verifyManifest(pub, survivor))) return { removed, pending };
  const survivorLoaded = await loadWriter(pair, user, survivor);
  if (survivorLoaded.notices.length) return { removed, pending };
  const writers = await listGraphWriters(user);
  for (const writerId of writers.slice(0, GRAPH_SCAN_MAX)) {
    if (writerId === survivor.writerId) continue;
    // Same queue as publication, so a sweep cannot run while this writer's records are stored and its manifest is not.
    await lock(writerQueue(survivor.owner, writerId), async () => {
      const pubs = await publicationsOf(user, writerId, pub);
      const head = highestPub(pubs);
      if (!head) return;
      const loaded = await loadWriter(pair, user, head.manifest);
      if (loaded.notices.length || !containsState(survivorLoaded.state, loaded.state)) return;
      if (containsState(loaded.state, survivorLoaded.state) && !survivorWins(survivor, head)) return;
      const deviceId = head.manifest.deviceId;
      const water = deviceId ? Math.max(highWater(loaded.state, deviceId), highWater(survivorLoaded.state, deviceId)) : 0;
      const published = deviceId && survivor.retirements && Object.hasOwn(survivor.retirements, deviceId) ? survivor.retirements[deviceId]! : 0;
      if (deviceId && water > 0 && published < water) return;
      for (const p of pubs.filter((item) => item.seq <= head.seq)) {
        const hash = await sha256Hex(manifestBody(p.manifest));
        let tomb: WriterTombstone;
        try {
          tomb = await signWriterTombstone(pair, {
            v: 1,
            owner: p.manifest.owner,
            writerId,
            seq: p.seq,
            manifestHash: hash,
            deviceId,
            counter: water,
          });
          await putString(user.get("s3rch-views-retired").get(writerSlotKey(writerId, p.seq)), JSON.stringify(tomb));
        } catch {
          pending.push(writerSlotKey(writerId, p.seq));
          continue;
        }
        if (await finishTombstoneBody(user, tomb, pub)) removed.push(writerSlotKey(writerId, p.seq));
        else pending.push(writerSlotKey(writerId, p.seq));
      }
    });
  }
  return { removed, pending };
}

/**
 * Publish `state`, folding devices whose writers are already contained in it, then remove
 * those writers. Retirements are in the published manifest before any of their slots are deleted.
 */
export async function publishViewsBackup(
  user: GraphChain,
  pair: SeaPair,
  state: ViewsState,
  writerId: string,
  seq: number,
  cache?: RecordCache,
  opts?: { pub?: string; lock?: <T>(name: string, run: () => Promise<T>) => Promise<T>; now?: () => number },
): Promise<{ state: ViewsState; status: "written" | "stale"; removed: string[]; pending: string[] }> {
  const pub = opts?.pub ?? pair.pub;
  const lock = opts?.lock ?? defaultLock();
  await retryWriterTombstones(user, pair, pub, lock);
  const adopted = adoptRetirements(state, await planRetirements(user, pair, state, writerId));
  const backup = await buildBackup(adopted, pair, writerId, seq, cache);
  const status = await writeBackupToGraph(user, backup, { pub, lock, now: opts?.now });
  if (status === "stale") return { state, status, removed: [], pending: [] };
  const pruned = await pruneSupersededWriters(user, pair, backup.manifest, pub, lock);
  return { state: adopted, status, removed: pruned.removed, pending: pruned.pending };
}

/**
 * Restore from the user's graph copy. Without explicit writer ids, the writer index is
 * read; manifests are still verified, so a bogus index entry only costs one lookup.
 * The highest sequence that is still stored wins. A newer sequence published during
 * pruning stays visible because pruning deletes only the sequence it tombstoned.
 */
export async function restoreFromGraph(state: ViewsState, pair: SeaPair, user: GraphChain, writerIds?: string[]): Promise<{ state: ViewsState; notices: Notice[] }> {
  const manifests: unknown[] = [];
  const ids = writerIds ?? (await listGraphWriters(user));
  // Skip entries whose manifest is gone or invalid, so they do not use up the manifest limit.
  for (const w of ids.slice(0, GRAPH_SCAN_MAX)) {
    if (manifests.length >= BACKUP_MAX_MANIFESTS) break;
    const head = highestPub(await publicationsOf(user, w, pair.pub));
    if (head && head.manifest.owner === state.owner) {
      manifests.push(head.manifest);
      continue;
    }
    const legacy = await readString(user.get("s3rch-views").get(w));
    if (isManifestShape(legacy) && legacy.owner === state.owner && legacy.writerId === w && (await verifyManifest(pair.pub, legacy))) manifests.push(legacy);
  }
  return restoreBackup(state, pair, manifests, (a, w) => readString(user.get("s3rch-views-records").get(w).get(a)));
}
