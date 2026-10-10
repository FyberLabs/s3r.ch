/**
 * Login paths are handles on one sociacl owner.
 *
 * Sociacl refuses co-ownership: an object has one owner. Here that owner is
 * the checksummed address that owns s3r.ch data. A wallet address and a
 * Keycloak `sub` are handles on that owner, not a second ownership system.
 * The binding stays in one JSON document. It is not written to Gun, and it
 * does not store provider tokens. Production keeps that document in one
 * private Azure Blob. Development keeps it in a local file.
 *
 * An OAuth sub with no handle is unlinked and is not an owner.
 */

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getAddress } from "viem";
import {
  createProductionBlobClient,
  IDENTITY_BLOB_MAX_BYTES,
  IDENTITY_BLOB_NAME,
  readBlobConfig,
  type IdentityBlobClient,
} from "../../identity-blob.cjs";
import { parseLinkFile as parseStoredLinkFile } from "../../identity-link-schema.cjs";
import { identityLinkPath } from "../../identity-storage.cjs";

export const LINK_FILE_V = 1;

const IDPS = ["microsoft", "github", "google"] as const;
export type LinkIdp = (typeof IDPS)[number];

export type LoginHandle =
  | { kind: "wallet"; address: string }
  | { kind: "oauth"; sub: string; idp: LinkIdp | null };

export type IdentityPerson = {
  /** Sociacl owner. Checksummed address. Not an OAuth sub. */
  owner: string;
  handles: LoginHandle[];
  /** ISO time the person confirmed they are at least 18. Absent until then. */
  ageConfirmedAt?: string;
};

/** Confirmation for an OAuth subject that is not a handle on an owner yet. */
export type OAuthAgeConfirmation = {
  sub: string;
  confirmedAt: string;
};

export type IdentityLinkFile = {
  v: typeof LINK_FILE_V;
  people: IdentityPerson[];
  oauthAge?: OAuthAgeConfirmation[];
};

export type LinkDenied = { denied: true; reason: "already-linked" | "bad-handle" | "store-unreadable" };

/**
 * Account-link storage. Production uses `BlobLinkStore` (one private blob).
 * Development and tests use `FileLinkStore`. See docs/identity-storage.md.
 */
export type LinkStore = {
  load(): { ok: true; file: IdentityLinkFile } | { ok: false; reason: "store-unreadable" | "unknown-version" };
  save(file: IdentityLinkFile): void;
  withLock?<T>(action: () => T): T;
};

const SUB_MAX = 256;

export function emptyLinkFile(): IdentityLinkFile {
  return { v: LINK_FILE_V, people: [] };
}

export function linkFilePath(): string {
  return identityLinkPath();
}

export class FileLinkStore implements LinkStore {
  constructor(private readonly filePath: string) {}

  private refuseProduction(): void {
    if (process.env.NODE_ENV === "production") {
      const error = new Error("s3r.ch: file identity storage is not used in production") as NodeJS.ErrnoException;
      error.code = "ERR_PRODUCTION_FILE_STORE";
      throw error;
    }
  }

  load(): ReturnType<LinkStore["load"]> {
    let raw: string;
    try {
      this.refuseProduction();
      raw = readFileSync(this.filePath, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" && process.env.NODE_ENV !== "production") return { ok: true, file: emptyLinkFile() };
      return { ok: false, reason: "store-unreadable" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return { ok: false, reason: "store-unreadable" };
    }
    return parseLinkFile(parsed);
  }

  withLock<T>(action: () => T): T {
    this.refuseProduction();
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const lock = `${this.filePath}.lock`;
    // One development writer at a time. Contention denies the write.
    // Never steal the directory: a crashed writer requires operator recovery.
    mkdirSync(lock, { mode: 0o700 });
    try {
      return action();
    } finally {
      rmdirSync(lock);
    }
  }

  save(file: IdentityLinkFile): void {
    this.refuseProduction();
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(file), "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.filePath);
  }
}

const BLOB_WRITE_ATTEMPTS = 5;

function isBlobConflict(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { code?: string }).code === "blob-conflict";
}

/**
 * One JSON document in one private blob. Writes send If-Match (or If-None-Match
 * when the blob is still absent). A conflict retries the whole read-modify-write.
 */
export class BlobLinkStore implements LinkStore {
  private etag: string | null = null;
  private missing = true;

  constructor(
    private readonly client: IdentityBlobClient,
    private readonly blobName = IDENTITY_BLOB_NAME,
  ) {}

  load(): ReturnType<LinkStore["load"]> {
    let downloaded: ReturnType<IdentityBlobClient["download"]>;
    try {
      downloaded = this.client.download(this.blobName);
    } catch {
      return { ok: false, reason: "store-unreadable" };
    }
    if (!downloaded.found) {
      this.missing = true;
      this.etag = null;
      if (process.env.NODE_ENV === "production") return { ok: false, reason: "store-unreadable" };
      return { ok: true, file: emptyLinkFile() };
    }
    if (!downloaded.etag || Buffer.byteLength(downloaded.text) > IDENTITY_BLOB_MAX_BYTES) {
      this.etag = null;
      this.missing = false;
      return { ok: false, reason: "store-unreadable" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(downloaded.text) as unknown;
    } catch {
      this.etag = null;
      return { ok: false, reason: "store-unreadable" };
    }
    const result = parseLinkFile(parsed);
    if (!result.ok) {
      this.etag = null;
      return result;
    }
    this.missing = false;
    this.etag = downloaded.etag;
    return result;
  }

  withLock<T>(action: () => T): T {
    let last: unknown;
    for (let attempt = 0; attempt < BLOB_WRITE_ATTEMPTS; attempt++) {
      try {
        return action();
      } catch (error) {
        if (!isBlobConflict(error)) throw error;
        last = error;
      }
    }
    throw last;
  }

  save(file: IdentityLinkFile): void {
    const body = JSON.stringify(file);
    if (Buffer.byteLength(body) > IDENTITY_BLOB_MAX_BYTES) {
      throw new Error("s3r.ch: identity document is too large");
    }
    if (this.missing || !this.etag) {
      if (process.env.NODE_ENV === "production") {
        throw new Error("s3r.ch: identity blob is missing");
      }
      const uploaded = this.client.upload(this.blobName, body, { ifNoneMatch: "*" });
      this.etag = uploaded.etag;
      this.missing = false;
      return;
    }
    const uploaded = this.client.upload(this.blobName, body, { ifMatch: this.etag });
    this.etag = uploaded.etag;
    this.missing = false;
  }
}

export type AgeStatus = { confirmedAt: string } | { needs: true } | { unavailable: true };

export type Links = {
  link(input: { wallet: string; sub: string; idp: LinkIdp | null }): { owner: string } | LinkDenied;
  ownerForWallet(wallet: string): string | null;
  ownerForOAuth(sub: string): string | null;
  ageStatusForWallet(wallet: string, oauthSub?: string | null): AgeStatus;
  ageStatusForOAuth(sub: string, wallet?: string | null): AgeStatus;
  saveWalletAge(
    wallet: string,
    confirmedAt: string,
    oauthSub?: string | null,
  ): { owner: string; confirmedAt: string } | LinkDenied;
  saveOAuthAge(sub: string, confirmedAt: string): { confirmedAt: string } | LinkDenied;
};

export function openLinks(store: LinkStore): Links {
  function load(): { ok: true; file: IdentityLinkFile } | LinkDenied {
    let loaded: ReturnType<LinkStore["load"]>;
    try {
      loaded = store.load();
    } catch {
      return { denied: true, reason: "store-unreadable" };
    }
    if (!loaded.ok) {
      return {
        denied: true,
        reason: loaded.reason === "unknown-version" ? "store-unreadable" : loaded.reason,
      };
    }
    return { ok: true, file: loaded.file };
  }

  function linkUnlocked(input: { wallet: string; sub: string; idp: LinkIdp | null }): { owner: string } | LinkDenied {
    const wallet = checksum(input.wallet);
    const sub = cleanSub(input.sub);
    const idp = cleanIdp(input.idp);
    if (!wallet || !sub || idp === "invalid") return { denied: true, reason: "bad-handle" };
    const opened = load();
    if ("denied" in opened) return opened;
    const file = opened.file;
    const byWallet = personForWallet(file, wallet);
    const bySub = personForSub(file, sub);
    if (byWallet && bySub && byWallet.owner !== bySub.owner) {
      return { denied: true, reason: "already-linked" };
    }
    if (bySub && !byWallet) {
      const asOwner = file.people.find((person) => person.owner === wallet);
      if (asOwner && asOwner.owner !== bySub.owner) {
        return { denied: true, reason: "already-linked" };
      }
      addWalletHandle(bySub, wallet);
      attachAge(file, bySub, sub);
      const saved = commit(file);
      if (saved) return saved;
      return { owner: bySub.owner };
    }
    if (byWallet && !bySub) {
      addOAuthHandle(byWallet, sub, idp);
      attachAge(file, byWallet, sub);
      const saved = commit(file);
      if (saved) return saved;
      return { owner: byWallet.owner };
    }
    if (byWallet && bySub) {
      addOAuthHandle(byWallet, sub, idp);
      if (attachAge(file, byWallet, sub)) {
        const saved = commit(file);
        if (saved) return saved;
      }
      return { owner: byWallet.owner };
    }
    const knownAge = stampForSub(file, sub);
    const person: IdentityPerson = {
      owner: wallet,
      handles: [
        { kind: "wallet", address: wallet },
        { kind: "oauth", sub, idp },
      ],
      ...(knownAge ? { ageConfirmedAt: knownAge } : {}),
    };
    file.people.push(person);
    const saved = commit(file);
    if (saved) return saved;
    return { owner: wallet };
  }

  function link(input: { wallet: string; sub: string; idp: LinkIdp | null }): { owner: string } | LinkDenied {
    try {
      return store.withLock ? store.withLock(() => linkUnlocked(input)) : linkUnlocked(input);
    } catch {
      return { denied: true, reason: "store-unreadable" };
    }
  }

  function commit(file: IdentityLinkFile): LinkDenied | null {
    if (file.oauthAge && file.oauthAge.length === 0) delete file.oauthAge;
    try {
      store.save(file);
      return null;
    } catch (error) {
      if (isBlobConflict(error)) throw error;
      return { denied: true, reason: "store-unreadable" };
    }
  }

  function ownerForWallet(wallet: string): string | null {
    const address = checksum(wallet);
    if (!address) return null;
    const opened = load();
    if ("denied" in opened) return process.env.NODE_ENV === "production" ? null : address;
    return personForWallet(opened.file, address)?.owner ?? address;
  }

  function ownerForOAuth(sub: string): string | null {
    const cleaned = cleanSub(sub);
    if (!cleaned) return null;
    const opened = load();
    if ("denied" in opened) return null;
    return personForSub(opened.file, cleaned)?.owner ?? null;
  }

  function ageStatusForWallet(wallet: string, oauthSub?: string | null): AgeStatus {
    const address = checksum(wallet);
    if (!address) return { needs: true };
    const opened = load();
    if ("denied" in opened) return { unavailable: true };
    const person = personForWallet(opened.file, address);
    if (person?.ageConfirmedAt) return { confirmedAt: person.ageConfirmedAt };
    if (oauthSub) {
      const fromSub = stampForSub(opened.file, oauthSub);
      if (fromSub) return { confirmedAt: fromSub };
    }
    return { needs: true };
  }

  function ageStatusForOAuth(sub: string, wallet?: string | null): AgeStatus {
    const cleaned = cleanSub(sub);
    if (!cleaned) return { needs: true };
    const opened = load();
    if ("denied" in opened) return { unavailable: true };
    const fromSub = stampForSub(opened.file, cleaned);
    if (fromSub) return { confirmedAt: fromSub };
    const address = wallet ? checksum(wallet) : null;
    const person = address ? personForWallet(opened.file, address) : undefined;
    if (person?.ageConfirmedAt) return { confirmedAt: person.ageConfirmedAt };
    return { needs: true };
  }

  function saveWalletAge(
    wallet: string,
    confirmedAt: string,
    oauthSub?: string | null,
  ): { owner: string; confirmedAt: string } | LinkDenied {
    return locked(() => {
      const address = checksum(wallet);
      const provided = cleanAgeStamp(confirmedAt);
      if (!address || !provided) return { denied: true, reason: "bad-handle" };
      const opened = load();
      if ("denied" in opened) return opened;
      const file = opened.file;
      const person = personForWallet(file, address);
      const fromSub = oauthSub ? stampForSub(file, oauthSub) : null;
      const stamp = person?.ageConfirmedAt ?? fromSub ?? provided;
      if (person?.ageConfirmedAt) return { owner: person.owner, confirmedAt: person.ageConfirmedAt };
      if (person) person.ageConfirmedAt = stamp;
      else {
        file.people.push({
          owner: address,
          handles: [{ kind: "wallet", address }],
          ageConfirmedAt: stamp,
        });
      }
      const saved = commit(file);
      if (saved) return saved;
      return { owner: person?.owner ?? address, confirmedAt: stamp };
    });
  }

  function saveOAuthAge(sub: string, confirmedAt: string): { confirmedAt: string } | LinkDenied {
    return locked(() => {
      const cleaned = cleanSub(sub);
      const provided = cleanAgeStamp(confirmedAt);
      if (!cleaned || !provided) return { denied: true, reason: "bad-handle" };
      const opened = load();
      if ("denied" in opened) return opened;
      const file = opened.file;
      const existing = stampForSub(file, cleaned);
      if (existing) return { confirmedAt: existing };
      const person = personForSub(file, cleaned);
      if (person) person.ageConfirmedAt = provided;
      const rows = file.oauthAge ?? [];
      rows.push({ sub: cleaned, confirmedAt: provided });
      file.oauthAge = rows;
      const saved = commit(file);
      if (saved) return saved;
      return { confirmedAt: provided };
    });
  }

  function locked<T>(action: () => T): T {
    try {
      return store.withLock ? store.withLock(action) : action();
    } catch {
      return { denied: true, reason: "store-unreadable" } as T;
    }
  }

  return {
    link,
    ownerForWallet,
    ownerForOAuth,
    ageStatusForWallet,
    ageStatusForOAuth,
    saveWalletAge,
    saveOAuthAge,
  };
}

const installedStoreKey = "__s3rchIdentityLinkStore";
let productionLinks: Links | undefined;

function installedStore(): LinkStore | undefined {
  return (globalThis as { [installedStoreKey]?: LinkStore })[installedStoreKey];
}

/** Tests install one store so every copy of this module, including route handlers, shares it. */
export function useLinkStore(store: LinkStore | null): void {
  const g = globalThis as { [installedStoreKey]?: LinkStore };
  if (store) g[installedStoreKey] = store;
  else delete g[installedStoreKey];
  productionLinks = undefined;
}

export function getLinks(): Links {
  const installed = installedStore();
  if (installed) return openLinks(installed);
  if (process.env.NODE_ENV === "production") {
    if (!productionLinks) {
      const config = readBlobConfig(process.env);
      productionLinks = openLinks(new BlobLinkStore(createProductionBlobClient(config)));
    }
    return productionLinks;
  }
  return openLinks(new FileLinkStore(linkFilePath()));
}

export function linkLoginPaths(input: {
  wallet: string;
  sub: string;
  idp: LinkIdp | null;
}): { owner: string } | LinkDenied {
  try {
    return getLinks().link(input);
  } catch {
    return { denied: true, reason: "store-unreadable" };
  }
}

export function ownerForWallet(wallet: string): string | null {
  try {
    return getLinks().ownerForWallet(wallet);
  } catch (error) {
    if (process.env.NODE_ENV !== "production") throw error;
    return null;
  }
}

export function ownerForOAuth(sub: string): string | null {
  try {
    return getLinks().ownerForOAuth(sub);
  } catch (error) {
    if (process.env.NODE_ENV !== "production") throw error;
    return null;
  }
}

export function parseLinkFile(value: unknown): ReturnType<LinkStore["load"]> {
  return parseStoredLinkFile(value);
}

const AGE_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function cleanAgeStamp(value: string): string | null {
  if (!AGE_STAMP.test(value) || !Number.isFinite(Date.parse(value))) return null;
  return value;
}

function stampForSub(file: IdentityLinkFile, sub: string): string | null {
  const cleaned = cleanSub(sub);
  if (!cleaned) return null;
  const person = personForSub(file, cleaned);
  if (person?.ageConfirmedAt) return person.ageConfirmedAt;
  return file.oauthAge?.find((row) => row.sub === cleaned)?.confirmedAt ?? null;
}

function attachAge(file: IdentityLinkFile, person: IdentityPerson, sub: string): boolean {
  if (person.ageConfirmedAt) return false;
  const stamp = stampForSub(file, sub);
  if (!stamp) return false;
  person.ageConfirmedAt = stamp;
  return true;
}

function personForWallet(file: IdentityLinkFile, wallet: string): IdentityPerson | undefined {
  return file.people.find((person) =>
    person.handles.some((handle) => handle.kind === "wallet" && handle.address === wallet),
  );
}

function personForSub(file: IdentityLinkFile, sub: string): IdentityPerson | undefined {
  return file.people.find((person) =>
    person.handles.some((handle) => handle.kind === "oauth" && handle.sub === sub),
  );
}

function addWalletHandle(person: IdentityPerson, wallet: string): void {
  if (person.handles.some((handle) => handle.kind === "wallet" && handle.address === wallet)) return;
  person.handles.push({ kind: "wallet", address: wallet });
}

function addOAuthHandle(person: IdentityPerson, sub: string, idp: LinkIdp | null): void {
  const existing = person.handles.find((handle) => handle.kind === "oauth" && handle.sub === sub);
  if (existing && existing.kind === "oauth") {
    if (idp && existing.idp !== idp) existing.idp = idp;
    return;
  }
  person.handles.push({ kind: "oauth", sub, idp });
}

function checksum(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return getAddress(value.trim());
  } catch {
    return null;
  }
}

function cleanSub(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const sub = value.trim();
  if (!sub || sub.length > SUB_MAX || /\s/.test(sub)) return null;
  if (/^0x[0-9a-fA-F]{40}$/.test(sub)) return null;
  return sub;
}

function cleanIdp(value: unknown): LinkIdp | null | "invalid" {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string" && (IDPS as readonly string[]).includes(value)) {
    return value as LinkIdp;
  }
  return "invalid";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}
