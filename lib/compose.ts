/**
 * Native s3r.ch posts. Same FeedItem / GunFeedNode shape as seed and overlay.
 * Default visibility is mine. Share-into-mesh is a separate explicit put.
 */

import { getAddress } from "viem";
import {
  normalizeTags,
  toGunNode,
  type FeedItem,
  type GunFeedNode,
} from "./feed-types";
import { admitFeedNode, encodeKey, type SeeAcl } from "./identity/check";

export const NATIVE_KIND = "post";
export const NATIVE_SOURCE = "s3rch" as const;

export type ComposeNativeInput = {
  body: string;
  address: string;
  tags?: string[];
  nowSeconds?: number;
  entropy?: string;
};

export type AdmitNativeResult =
  | { item: FeedItem; object: string }
  | { denied: true };

export type ShareIntoMeshResult =
  | { node: GunFeedNode; key: string }
  | { denied: true };

/** encodeKey-safe short entropy (hex). */
export function shortPostEntropy(bytes = 4): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

function encodeKeySafe(value: string): string {
  return value.replace(/[.#$[\]]/g, "");
}

/**
 * Build a native post. Empty / whitespace body is rejected.
 * Tags always include `user` (same as overlay ingest) and `s3rch`.
 */
export function composeNativePost(input: ComposeNativeInput): FeedItem | null {
  const body = input.body.trim();
  if (!body) return null;

  let author: string;
  try {
    author = getAddress(input.address);
  } catch {
    return null;
  }

  const ts =
    typeof input.nowSeconds === "number" && Number.isFinite(input.nowSeconds)
      ? Math.floor(input.nowSeconds)
      : Math.floor(Date.now() / 1000);
  const entropy = encodeKeySafe((input.entropy ?? shortPostEntropy()).trim());
  if (!entropy) return null;

  const id = `s3rch:post:${author}:${ts}:${entropy}`;
  return {
    id,
    source: NATIVE_SOURCE,
    kind: NATIVE_KIND,
    author,
    body,
    ts,
    permalink: "",
    tags: normalizeTags([...(input.tags ?? []), "user", "s3rch"]),
    provenance: `s3rch:native:${author}`,
  };
}

/** Dest re-auth before overlay register. Hint / URL fetch is not authorization. */
export function admitNativePost(
  acl: SeeAcl,
  item: FeedItem,
  owner: string,
): AdmitNativeResult {
  if (item.source !== NATIVE_SOURCE) return { denied: true };
  const admitted = admitFeedNode(acl, toGunNode(item), owner);
  if ("denied" in admitted) return { denied: true };
  return { item, object: admitted.object };
}

/**
 * Prepare an explicit share-into-mesh put.
 * Does not grant see. Does not call OutboundAdapter.
 */
export function prepareShareIntoMesh(
  acl: SeeAcl,
  item: FeedItem,
  owner: string,
): ShareIntoMeshResult {
  const admitted = admitNativePost(acl, item, owner);
  if ("denied" in admitted) return { denied: true };
  return { node: toGunNode(item), key: encodeKey(item.id) };
}

export function isNativePost(item: Pick<FeedItem, "source" | "kind">): boolean {
  return item.source === NATIVE_SOURCE && item.kind === NATIVE_KIND;
}

export function ownsNativePost(
  item: Pick<FeedItem, "source" | "author">,
  address: string | null | undefined,
): boolean {
  if (!address || item.source !== NATIVE_SOURCE) return false;
  try {
    return getAddress(item.author) === getAddress(address);
  } catch {
    return false;
  }
}
