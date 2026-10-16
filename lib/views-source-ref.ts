/**
 * SourceRef: a stable reference to one source (room, forum channel, feed, stream,
 * voice room) on one network. See docs/views.md §2.
 *
 * Canonical string: "sr1:" + pct(network) + "/" + pct(owner) + "/" + pct(source) + "/" + kind
 * Shareable string: canonical + optional "?b=", "&r=", "&rc=" binding hints.
 */
import { getAddress, isAddress } from "viem";

export const SOURCE_KINDS = ["chat", "forum", "feed", "stream", "voice"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const OPEN_PROTOCOL_NETWORKS = ["atproto", "farcaster", "nostr", "activitypub", "rss"] as const;
export type OpenProtocolNetwork = (typeof OPEN_PROTOCOL_NETWORKS)[number];

export type SourceRef = {
  network: string;
  owner: string;
  source: string;
  kind: SourceKind;
  bindingHash?: string;
  rootBindingHash?: string;
  rootCounter?: number;
  v: 1;
};

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const CANONICAL_PREFIX = "sr1:";
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_COMPONENT = 2048;

function fail<T>(error: string): Result<T> {
  return { ok: false, error };
}

/** Percent-encode every UTF-8 byte outside RFC 3986 unreserved (A-Z a-z 0-9 - . _ ~). */
export function pct(value: string): string {
  // encodeURIComponent also leaves ! ' ( ) * unescaped; escape those so only unreserved remain.
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function decodeComponent(raw: string): string | null {
  if (raw === "") return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  // Injectivity: the component must be exactly the canonical encoding of its decoded value.
  let again: string;
  try {
    again = pct(decoded);
  } catch {
    return null;
  }
  return again === raw ? decoded : null;
}

export function isSourceKind(value: unknown): value is SourceKind {
  return typeof value === "string" && (SOURCE_KINDS as readonly string[]).includes(value);
}

function isOpenProtocol(value: string): value is OpenProtocolNetwork {
  return (OPEN_PROTOCOL_NETWORKS as readonly string[]).includes(value);
}

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Public DNS hostname only: lowercase labels, at least one dot, no IP literals. */
function isPublicHostname(host: string): boolean {
  if (host.length > 253 || !host.includes(".")) return false;
  const labels = host.split(".");
  if (!labels.every((l) => DNS_LABEL.test(l))) return false;
  // Reject all-numeric hosts (dotted IPv4 and similar); the last label of a real name is not numeric.
  if (/^[0-9]+$/.test(labels[labels.length - 1] ?? "")) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  return true;
}

const S3RCH_NETWORK = /^s3rch:https:\/\/([^/:;]+):([0-9]{1,5});key=([0-9a-f]{64})$/;

/**
 * Network id for an s3r.ch deployment: "s3rch:https://host:port;key=<sha256 hex of permitted key>".
 * Scheme, host and explicit port are part of the identity.
 */
export function formatS3rchNetwork(host: string, port: number, keyFingerprint: string): Result<string> {
  const id = `s3rch:https://${host}:${port};key=${keyFingerprint}`;
  return validateNetwork(id).ok ? { ok: true, value: id } : fail("invalid s3r.ch network");
}

export function validateNetwork(network: string): Result<string> {
  if (isOpenProtocol(network)) return { ok: true, value: network };
  const m = S3RCH_NETWORK.exec(network);
  if (!m) return fail("unknown network");
  const [, host, portText] = m;
  const port = Number(portText);
  if (!host || !isPublicHostname(host)) return fail("network host must be a public hostname");
  if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== portText) {
    return fail("network port is invalid");
  }
  return { ok: true, value: network };
}

function isHttpsUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.href === value && u.username === "" && u.password === "" && u.hash === "";
  } catch {
    return false;
  }
}

/** Owner must be the stable identifier for its network, never a handle. */
export function validateOwner(network: string, owner: string): Result<string> {
  if (owner === "" || owner.length > MAX_COMPONENT) return fail("owner is empty or too long");
  if (network.startsWith("s3rch:")) {
    if (!isAddress(owner, { strict: false }) || getAddress(owner) !== owner) {
      return fail("s3r.ch owner must be a checksummed wallet address");
    }
    return { ok: true, value: owner };
  }
  switch (network) {
    case "atproto":
      return /^did:(plc:[a-z2-7]{24}|web:[a-z0-9.-]+)$/.test(owner) ? { ok: true, value: owner } : fail("ATProto owner must be a DID");
    case "farcaster":
      return /^[1-9][0-9]{0,15}$/.test(owner) ? { ok: true, value: owner } : fail("Farcaster owner must be an FID");
    case "nostr":
      return HEX64.test(owner) ? { ok: true, value: owner } : fail("Nostr owner must be a lowercase hex pubkey");
    case "activitypub":
      return isHttpsUrl(owner) ? { ok: true, value: owner } : fail("ActivityPub owner must be an https actor id");
    case "rss":
      try {
        const u = new URL(owner);
        if ((u.protocol === "https:" || u.protocol === "http:") && u.origin === owner) return { ok: true, value: owner };
      } catch {
        /* fall through */
      }
      return fail("RSS owner must be a feed origin");
    default:
      return fail("unknown network");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const REF_KEYS = new Set(["network", "owner", "source", "kind", "bindingHash", "rootBindingHash", "rootCounter", "v"]);

/** Validate an untrusted value as a SourceRef. Unknown fields are rejected. */
export function validateSourceRef(input: unknown): Result<SourceRef> {
  if (!isRecord(input)) return fail("not an object");
  for (const key of Object.keys(input)) if (!REF_KEYS.has(key)) return fail(`unknown field ${key}`);
  const { network, owner, source, kind, bindingHash, rootBindingHash, rootCounter, v } = input;
  if (v !== 1) return fail("unsupported version");
  if (typeof network !== "string") return fail("network missing");
  const net = validateNetwork(network);
  if (!net.ok) return net;
  if (typeof owner !== "string") return fail("owner missing");
  const own = validateOwner(network, owner);
  if (!own.ok) return own;
  if (typeof source !== "string" || source === "" || source.length > MAX_COMPONENT) return fail("source is empty or too long");
  if (!isSourceKind(kind)) return fail("unknown kind");
  const ref: SourceRef = { network, owner, source, kind, v: 1 };
  const isS3rch = network.startsWith("s3rch:");
  if (bindingHash !== undefined) {
    if (!isS3rch || typeof bindingHash !== "string" || !HEX64.test(bindingHash)) return fail("bindingHash is invalid");
    ref.bindingHash = bindingHash;
  }
  if (rootBindingHash !== undefined) {
    if (!isS3rch || typeof rootBindingHash !== "string" || !HEX64.test(rootBindingHash)) return fail("rootBindingHash is invalid");
    ref.rootBindingHash = rootBindingHash;
  }
  if (rootCounter !== undefined) {
    if (!isS3rch || typeof rootCounter !== "number" || !Number.isSafeInteger(rootCounter) || rootCounter < 0) {
      return fail("rootCounter is invalid");
    }
    ref.rootCounter = rootCounter;
  }
  if ((ref.rootBindingHash === undefined) !== (ref.rootCounter === undefined)) {
    return fail("rootBindingHash and rootCounter go together");
  }
  return { ok: true, value: ref };
}

export function formatCanonical(ref: SourceRef): string {
  return `${CANONICAL_PREFIX}${pct(ref.network)}/${pct(ref.owner)}/${pct(ref.source)}/${ref.kind}`;
}

export function parseCanonical(text: string): Result<SourceRef> {
  if (!text.startsWith(CANONICAL_PREFIX)) return fail("not a SourceRef");
  const parts = text.slice(CANONICAL_PREFIX.length).split("/");
  if (parts.length !== 4) return fail("wrong number of components");
  const [n, o, s, k] = parts;
  const network = decodeComponent(n ?? "");
  const owner = decodeComponent(o ?? "");
  const source = decodeComponent(s ?? "");
  if (network === null || owner === null || source === null) return fail("component is empty or not canonically encoded");
  return validateSourceRef({ network, owner, source, kind: k, v: 1 });
}

/** Canonical string plus binding hints, in fixed order. */
export function formatShareable(ref: SourceRef): string {
  const params: string[] = [];
  if (ref.bindingHash) params.push(`b=${pct(ref.bindingHash)}`);
  if (ref.rootBindingHash !== undefined && ref.rootCounter !== undefined) {
    params.push(`r=${pct(ref.rootBindingHash)}`, `rc=${ref.rootCounter}`);
  }
  const canonical = formatCanonical(ref);
  return params.length ? `${canonical}?${params.join("&")}` : canonical;
}

export function parseShareable(text: string): Result<SourceRef> {
  const q = text.indexOf("?");
  const base = parseCanonical(q === -1 ? text : text.slice(0, q));
  if (!base.ok || q === -1) return base;
  const hints: Record<string, unknown> = {};
  const order = ["b", "r", "rc"];
  let last = -1;
  for (const pair of text.slice(q + 1).split("&")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) return fail("malformed hint");
    const key = pair.slice(0, eq);
    const idx = order.indexOf(key);
    if (idx <= last) return fail("unknown, repeated or out-of-order hint");
    last = idx;
    const value = decodeComponent(pair.slice(eq + 1));
    if (value === null) return fail("hint is empty or not canonically encoded");
    if (key === "b") hints.bindingHash = value;
    else if (key === "r") hints.rootBindingHash = value;
    else {
      if (!/^(0|[1-9][0-9]*)$/.test(value)) return fail("rootCounter is invalid");
      hints.rootCounter = Number(value);
    }
  }
  return validateSourceRef({ ...base.value, ...hints });
}

/** Identity comparison: network, owner, source and kind only. */
export function sameSource(a: SourceRef, b: SourceRef): boolean {
  return a.network === b.network && a.owner === b.owner && a.source === b.source && a.kind === b.kind;
}
