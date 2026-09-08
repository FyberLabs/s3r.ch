/**
 * Honest unshare / HAM-delete of a previously shared Gun object.
 * Own-only confirm + tombstone put. Not a see-grant revoke.
 * Observation can wait (mesh delay). Privilege-down for grants stays dest ACL.
 */

import {
  isUnsharePut,
  toUnshareTombstone,
  unshareIdOf,
  type FeedItem,
} from "./feed-types";
import { encodeKey } from "./identity/check";

export {
  UNSHARE_MARKER,
  isUnshareMarker,
  isUnsharePut,
  toUnshareTombstone,
  unshareIdOf,
} from "./feed-types";

export type UnshareTombstone = ReturnType<typeof toUnshareTombstone> & {
  source?: null;
  kind?: null;
  author?: null;
  body?: null;
  permalink?: null;
  tags?: null;
  provenance?: null;
  title?: null;
  owner?: null;
  indicators?: null;
};

export type UnshareResult =
  | { tombstone: UnshareTombstone; key: string }
  | { denied: true };

export const UNSHARE_COPY =
  "Unshare removes this from public. It can take a moment for others.";

export const ROOM_UNSHARE_COPY =
  "Unshare removes this room from public. Your posts stay on Mine.";

export const USER_UNSHARE_COPY =
  "Unshare removes this from public.";

export const CLAIM_UNSHARE_COPY =
  "Unshare removes this name from public.";

export function soulKeyMatches(id: string, needle: string): boolean {
  const a = id.trim();
  const b = needle.trim();
  if (!a || !b) return false;
  if (a === b) return true;
  return encodeKey(a) === b || encodeKey(b) === a || encodeKey(a) === encodeKey(b);
}

export function dropById<T extends { id: string }>(
  rows: readonly T[],
  idOrKey: string,
): T[] {
  return rows.filter((row) => !soulKeyMatches(row.id, idOrKey));
}

export function dropFeedItems(
  items: readonly FeedItem[],
  idOrKey: string,
): FeedItem[] {
  return dropById(items, idOrKey);
}

/** HAM-null leftover content so a prior share does not keep the body. */
export function itemUnshareTombstone(
  id: string,
  nowSeconds?: number,
): UnshareTombstone {
  return {
    ...toUnshareTombstone(id, nowSeconds),
    source: null,
    kind: null,
    author: null,
    body: null,
    permalink: null,
    tags: null,
    provenance: null,
  };
}

export function roomUnshareTombstone(
  id: string,
  nowSeconds?: number,
): UnshareTombstone {
  return {
    ...toUnshareTombstone(id, nowSeconds),
    title: null,
    owner: null,
    tags: null,
    provenance: null,
  };
}

export function userUnshareTombstone(
  id: string,
  nowSeconds?: number,
): UnshareTombstone {
  return {
    ...toUnshareTombstone(id, nowSeconds),
    indicators: null,
    provenance: null,
  };
}

export function readUnshareId(data: unknown, gunKey?: string): string | null {
  if (!isUnsharePut(data)) return null;
  return unshareIdOf(data, gunKey);
}
