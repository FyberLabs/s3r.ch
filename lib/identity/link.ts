/**
 * Login paths are handles on one sociacl owner.
 *
 * Sociacl refuses co-ownership: an object has one owner. Here that owner is
 * the checksummed address that owns s3r.ch data. A wallet address and a
 * Keycloak `sub` are handles on that owner, not a second ownership system.
 * The binding stays in this JSON file. It is not written to Gun, and it
 * does not store provider tokens.
 *
 * An OAuth sub with no handle is unlinked and is not an owner.
 */

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getAddress } from "viem";
import { parseLinkFile as parseStoredLinkFile } from "../../identity-link-schema.cjs";
import { assertIdentityStorage, identityLinkPath } from "../../identity-storage.cjs";

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
};

export type IdentityLinkFile = {
  v: typeof LINK_FILE_V;
  people: IdentityPerson[];
};

export type LinkDenied = { denied: true; reason: "already-linked" | "bad-handle" | "store-unreadable" };

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

  load(): ReturnType<LinkStore["load"]> {
    let raw: string;
    try {
      assertIdentityStorage();
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
    assertIdentityStorage();
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const lock = `${this.filePath}.lock`;
    // Atomic across processes on the mounted volume. Contention denies the write.
    // Never steal a lock: a crashed writer requires operator recovery.
    mkdirSync(lock, { mode: 0o700 });
    try {
      return action();
    } finally {
      rmdirSync(lock);
    }
  }

  save(file: IdentityLinkFile): void {
    assertIdentityStorage();
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

export type Links = {
  link(input: { wallet: string; sub: string; idp: LinkIdp | null }): { owner: string } | LinkDenied;
  ownerForWallet(wallet: string): string | null;
  ownerForOAuth(sub: string): string | null;
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
      const saved = commit(file);
      if (saved) return saved;
      return { owner: bySub.owner };
    }
    if (byWallet && !bySub) {
      addOAuthHandle(byWallet, sub, idp);
      const saved = commit(file);
      if (saved) return saved;
      return { owner: byWallet.owner };
    }
    if (byWallet && bySub) {
      addOAuthHandle(byWallet, sub, idp);
      return { owner: byWallet.owner };
    }
    const person: IdentityPerson = {
      owner: wallet,
      handles: [
        { kind: "wallet", address: wallet },
        { kind: "oauth", sub, idp },
      ],
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
    try {
      store.save(file);
      return null;
    } catch {
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

  return { link, ownerForWallet, ownerForOAuth };
}

export function getLinks(): Links {
  return openLinks(new FileLinkStore(linkFilePath()));
}

export function linkLoginPaths(input: {
  wallet: string;
  sub: string;
  idp: LinkIdp | null;
}): { owner: string } | LinkDenied {
  return getLinks().link(input);
}

export function ownerForWallet(wallet: string): string | null {
  return getLinks().ownerForWallet(wallet);
}

export function ownerForOAuth(sub: string): string | null {
  return getLinks().ownerForOAuth(sub);
}

export function parseLinkFile(value: unknown): ReturnType<LinkStore["load"]> {
  return parseStoredLinkFile(value);
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
