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
import { CONFLICTS_MAX, countEntries, ENTRIES_MAX, isLiveEntry, mergeVersionChecked, parseVersion, TOMBSTONES_MAX, VIEWS_MAX, type ViewsState, type ViewVersion } from "./views-store";
import { isSafeKey } from "./views-vv";
import type { Notice } from "./views-window";

export const BACKUP_FILE_KIND = "s3rch-views-backup";
export const BACKUP_FILE_MAX_BYTES = 5 * 1024 * 1024;
export const BACKUP_MAX_MANIFESTS = 16;
/** Every version a state can hold: each entry × (current + CONFLICTS_MAX copies). */
export const BACKUP_MAX_ENTRIES = ENTRIES_MAX * (1 + CONFLICTS_MAX);
const HKDF_SALT = "s3rch-views-backup-v1";

export type EncryptedRecord = { v: 1; iv: string; ct: string };
export type ManifestEntry = { id: string; address: string };
export type Manifest = { v: 1; owner: string; writerId: string; seq: number; entries: ManifestEntry[]; sig: string };
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
  return canonicalJson({ v: m.v, owner: m.owner, writerId: m.writerId, seq: m.seq, entries: m.entries });
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
  const key = await deriveBackupKey(pair);
  const records: Record<string, EncryptedRecord> = {};
  const entries: ManifestEntry[] = [];
  const used = new Set<string>();
  for (const entry of Object.values(state.views)) {
    for (const version of [entry.current, ...entry.conflicts]) {
      const digest = await sha256Hex(`${state.owner}\n${canonicalJson(version)}`);
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
  for (const k of [...cache.keys()]) if (!used.has(k)) cache.delete(k);
  entries.sort((a, b) => (a.id + a.address < b.id + b.address ? -1 : 1));
  const manifest = await signManifest(pair, { v: 1, owner: state.owner, writerId, seq, entries });
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
    m.entries.every((e) => typeof e === "object" && e !== null && typeof e.id === "string" && isSafeKey(e.id) && typeof e.address === "string" && /^[0-9a-f]{64}$/.test(e.address))
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
  fetchRecord: (address: string) => Promise<unknown>,
): Promise<{ state: ViewsState; notices: Notice[] }> {
  const notices: Notice[] = [];
  const key = await deriveBackupKey(pair);
  const views = { ...state.views };
  // Keep only the highest seq per writer.
  const latest = new Map<string, Manifest>();
  for (const m of manifests.slice(0, BACKUP_MAX_MANIFESTS)) {
    if (!isManifestShape(m) || m.owner !== state.owner || !(await verifyManifest(pair.pub, m))) {
      notices.push({ message: "A backup manifest could not be verified and was skipped" });
      continue;
    }
    const prior = latest.get(m.writerId);
    if (!prior || m.seq > prior.seq) latest.set(m.writerId, m);
  }
  for (const m of latest.values()) {
    for (const e of m.entries) {
      let raw: unknown;
      try {
        raw = await fetchRecord(e.address);
      } catch {
        raw = undefined;
      }
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
      const counts = countEntries({ ...state, views });
      const becomesLive = isLiveEntry(merged.entry) && !(prior && isLiveEntry(prior));
      if ((becomesLive && counts.live >= VIEWS_MAX) || (!prior && !becomesLive && counts.tombstones >= TOMBSTONES_MAX)) {
        notices.push({ message: `View limit reached; view ${e.id} was not restored` });
        continue;
      }
      if (merged.overflow) {
        notices.push({ windowId: undefined, message: `View ${e.id} has too many conflicting copies; resolve them and restore again` });
        continue;
      }
      views[e.id] = merged.entry;
    }
  }
  return { state: { ...state, views }, notices };
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
 * `~<pub>/s3rch-views-records/<address>` and `~<pub>/s3rch-views/<writerId>`.
 * The manifest is written last so it never names a record that is not stored yet.
 */
export async function writeBackupToGraph(
  user: GraphChain,
  backup: { manifest: Manifest; records: Record<string, EncryptedRecord> },
  lock: <T>(name: string, run: () => Promise<T>) => Promise<T> = defaultLock(),
): Promise<"written" | "stale"> {
  const { manifest } = backup;
  // Serialized per writer across tabs; a lower or equal seq never replaces a published manifest.
  return lock(`s3rch-views-backup:${manifest.owner}:${manifest.writerId}`, async () => {
    const slot = user.get("s3rch-views").get(manifest.writerId);
    const existing = await readString(slot);
    const prior = isManifestShape(existing) && existing.owner === manifest.owner ? existing : null;
    if (prior && prior.seq >= manifest.seq) return "stale";
    const known = new Set(prior?.entries.map((e) => e.address) ?? []);
    for (const [address, record] of Object.entries(backup.records)) {
      // Rewrite a known record if it is no longer readable (for example, lost by partial retention).
      if (known.has(address) && isRecordShape(await readString(user.get("s3rch-views-records").get(address)))) continue;
      await putString(user.get("s3rch-views-records").get(address), JSON.stringify(record));
    }
    await putString(slot, JSON.stringify(manifest));
    // Reclaim records the previous manifest named and the new one does not.
    const now = new Set(manifest.entries.map((e) => e.address));
    for (const address of known) if (!now.has(address)) await putString(user.get("s3rch-views-records").get(address), null);
    return "written";
  });
}

/** Read the manifests for the given writer ids and restore from the user's graph copy. */
export async function restoreFromGraph(state: ViewsState, pair: SeaPair, user: GraphChain, writerIds: string[]): Promise<{ state: ViewsState; notices: Notice[] }> {
  const manifests: unknown[] = [];
  for (const w of writerIds.slice(0, BACKUP_MAX_MANIFESTS)) {
    const m = await readString(user.get("s3rch-views").get(w));
    if (m !== undefined) manifests.push(m);
  }
  return restoreBackup(state, pair, manifests, (a) => readString(user.get("s3rch-views-records").get(a)));
}
