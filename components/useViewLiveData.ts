"use client";

/**
 * Subscribes the open View to room chat, forum channels and pulled feeds, and builds the
 * picker's Browse list from the same rooms, channels and feeds. Access is `sourceAccess`
 * against the signed-in owner and the See ACL graph, refreshed when that graph or the
 * clock changes. Other networks stay on "Needs connection" until plan item 13.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fromGunChatNode, type ChatMessage } from "@/lib/chat";
import { isUnsharePut, fromGunNode, type FeedItem } from "@/lib/feed-types";
import type { ForumMessage } from "@/lib/forum";
import { acceptGrantDelivery, grantInboxRef } from "@/lib/grant-delivery";
import { browserGunOptions, listenThenConnectSeedPeer, type SeedPeerEmitter } from "@/lib/gun-peer";
import { encodeKey } from "@/lib/identity/check";
import { mergeItems } from "@/lib/merge";
import { dropRooms, fromGunRoomNode, mergeRooms, type Room } from "@/lib/rooms";
import { dropFeedItems, readUnshareId } from "@/lib/unshare";
import type { ViewRow } from "@/lib/views-adapters";
import { sourceAccess, type AccessState } from "@/lib/views-access";
import type { ObservedRow } from "@/lib/views-decorators";
import {
  DEPLOYMENT_SELF_NETWORK,
  ROWS_PER_SOURCE,
  browseSources,
  createSubscriptionSet,
  observeSource,
  readFeedItems,
  readForumCatalog,
  rowsForChat,
  rowsForFeed,
  rowsForForum,
  sourcesOfView,
  type CatalogChannel,
  type Stop,
  type SubscriptionSet,
} from "@/lib/views-live";
import type { PickerSource } from "@/lib/views-picker";
import { formatCanonical, type SourceRef } from "@/lib/views-source-ref";
import type { View } from "@/lib/views-window";
import { useGunPeer, type FeedGun } from "./GunPeerProvider";
import { useSeeAcl } from "./SeeAclProvider";

const FORUM_POLL_MS = 4000;
const FEED_POLL_MS = 15_000;
const ACCESS_TICK_MS = 30_000;

const IDLE = {
  rows: [] as ObservedRow[],
  access: (): AccessState => ({ kind: "on-open" }),
  sources: [] as PickerSource[],
  selfNetwork: DEPLOYMENT_SELF_NETWORK,
};

function sameObserved(prev: readonly ObservedRow[], next: readonly ObservedRow[]): boolean {
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    const a = prev[i]!;
    const b = next[i]!;
    if (a.observedAt !== b.observedAt || a.row.key !== b.row.key || a.row.body !== b.row.body || a.row.ts !== b.row.ts || a.row.author !== b.row.author || a.row.permalink !== b.row.permalink) {
      return false;
    }
  }
  return true;
}

function flattenBooks(books: ReadonlyMap<string, readonly ObservedRow[]>): ObservedRow[] {
  const out: ObservedRow[] = [];
  for (const rows of books.values()) out.push(...rows);
  out.sort((a, b) => b.observedAt - a.observedAt || (a.row.key < b.row.key ? -1 : 1));
  return out;
}

function subscribeRoomChat(gun: FeedGun, ref: SourceRef, onRows: (rows: ViewRow[]) => void): Stop {
  const acc = new Map<string, ChatMessage>();
  let live = true;
  const publish = () => {
    if (!live) return;
    const messages = [...acc.values()].sort((a, b) => b.ts - a.ts).slice(0, ROWS_PER_SOURCE);
    if (acc.size > messages.length) {
      acc.clear();
      for (const message of messages) acc.set(message.id, message);
    }
    onRows(rowsForChat(ref, messages));
  };
  const listener = gun
    .get("s3rch")
    .get("rooms")
    .get(encodeKey(ref.source))
    .get("chat")
    .map()
    .on((data, key) => {
      if (!live) return;
      if (data == null || isUnsharePut(data)) {
        const id = data && typeof data === "object" && typeof (data as { id?: unknown }).id === "string" ? (data as { id: string }).id : "";
        if (id) acc.delete(id);
        else {
          for (const messageId of [...acc.keys()]) {
            if (encodeKey(messageId) === key) acc.delete(messageId);
          }
        }
        publish();
        return;
      }
      const message = fromGunChatNode(data as Parameters<typeof fromGunChatNode>[0]);
      if (!message || message.room !== ref.source) return;
      acc.set(message.id, message);
      publish();
    });
  return () => {
    live = false;
    if (typeof listener.off === "function") listener.off();
  };
}

export function useViewLiveData(view: View | null, owner: string, enabled: boolean) {
  const see = useSeeAcl();
  const peer = useGunPeer();
  const registerRef = useRef(peer?.register);
  registerRef.current = peer?.register;
  const aclRef = useRef(see?.acl);
  aclRef.current = see?.acl;
  const persistRef = useRef(see?.persist);
  persistRef.current = see?.persist;

  const [rooms, setRooms] = useState<Room[]>([]);
  const [channels, setChannels] = useState<CatalogChannel[]>([]);
  const [items, setItems] = useState<FeedItem[]>([]);
  const [rows, setRows] = useState<ObservedRow[]>([]);
  const [gunReady, setGunReady] = useState(false);
  const [graphEpoch, setGraphEpoch] = useState(0);
  const [checkedAt, setCheckedAt] = useState(() => Math.floor(Date.now() / 1000));

  const gunRef = useRef<FeedGun | null>(null);
  const books = useRef(new Map<string, ObservedRow[]>());
  const fans = useRef(new Map<string, () => void>());
  const forumCache = useRef<ForumMessage[]>([]);
  const seedItems = useRef<FeedItem[]>([]);
  const gunItems = useRef<FeedItem[]>([]);
  const itemCache = useRef<FeedItem[]>([]);
  const subs = useRef<SubscriptionSet | null>(null);
  const sourcesRef = useRef<SourceRef[]>([]);

  const sources = useMemo(() => (enabled ? sourcesOfView(view) : []), [enabled, view]);
  const sourceKey = sources.map((ref) => formatCanonical(ref)).join("\n");
  sourcesRef.current = sources;

  const publishRows = useCallback((ref: SourceRef, incoming: readonly ViewRow[]) => {
    const key = formatCanonical(ref);
    const next = observeSource(books.current.get(key) ?? [], incoming, Date.now() / 1000);
    const prev = books.current.get(key) ?? [];
    if (sameObserved(prev, next)) return;
    books.current.set(key, next);
    setRows(flattenBooks(books.current));
  }, []);

  const notify = useCallback(() => {
    for (const run of [...fans.current.values()]) run();
  }, []);

  const rememberItems = useCallback(() => {
    const merged = mergeItems(seedItems.current, gunItems.current);
    itemCache.current = merged;
    setItems(merged);
    notify();
  }, [notify]);

  const openRef = useRef<(ref: SourceRef) => Stop | null>(() => null);
  openRef.current = (ref) => {
    if (ref.kind === "chat") {
      const gun = gunRef.current;
      if (!gun) return null;
      return subscribeRoomChat(gun, ref, (chatRows) => publishRows(ref, chatRows));
    }
    if (ref.kind !== "forum" && ref.kind !== "feed") return () => {};
    const key = formatCanonical(ref);
    const run = () => {
      const incoming =
        ref.kind === "forum"
          ? rowsForForum(ref, forumCache.current)
          : rowsForFeed(ref, itemCache.current, DEPLOYMENT_SELF_NETWORK);
      publishRows(ref, incoming);
    };
    fans.current.set(key, run);
    run();
    return () => {
      fans.current.delete(key);
    };
  };

  useEffect(() => {
    if (!enabled || !see?.acl) return;
    return see.acl.subscribe(() => setGraphEpoch((n) => n + 1));
  }, [enabled, see?.acl]);

  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => setCheckedAt(Math.floor(Date.now() / 1000)), ACCESS_TICK_MS);
    return () => window.clearInterval(id);
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let offRooms: (() => void) | undefined;
    let offItems: (() => void) | undefined;

    (async () => {
      try {
        const GunMod = await import("gun/browser");
        const Gun = (GunMod.default ?? GunMod) as unknown as (opts?: object) => FeedGun;
        if (cancelled) return;
        const gun = Gun(browserGunOptions());
        gunRef.current = gun;
        registerRef.current?.(gun);
        listenThenConnectSeedPeer(gun as unknown as SeedPeerEmitter, window.location.origin, () => {});

        const roomsListener = gun.get("s3rch").get("rooms").map().on((data, key) => {
          if (cancelled) return;
          const unshared = readUnshareId(data, key);
          if (unshared) {
            setRooms((prev) => dropRooms(prev, unshared));
            return;
          }
          const room = fromGunRoomNode(data as Parameters<typeof fromGunRoomNode>[0]);
          if (!room) return;
          setRooms((prev) => mergeRooms(prev, [room]));
        });
        offRooms = typeof roomsListener.off === "function" ? () => roomsListener.off?.() : undefined;

        const itemsListener = gun.get("s3rch").get("items").map().on((data, key) => {
          if (cancelled) return;
          const unshared = readUnshareId(data, key);
          if (unshared) {
            gunItems.current = dropFeedItems(gunItems.current, unshared);
            seedItems.current = dropFeedItems(seedItems.current, unshared);
            rememberItems();
            return;
          }
          const row = fromGunNode(data as Parameters<typeof fromGunNode>[0]);
          if (!row) return;
          gunItems.current = mergeItems(gunItems.current, [row]);
          rememberItems();
        });
        offItems = typeof itemsListener.off === "function" ? () => itemsListener.off?.() : undefined;
        if (!cancelled) setGunReady(true);
      } catch {
        if (!cancelled) setGunReady(false);
      }
    })();

    return () => {
      cancelled = true;
      offRooms?.();
      offItems?.();
      gunRef.current = null;
      registerRef.current?.(null);
      setGunReady(false);
    };
  }, [enabled, rememberItems]);

  useEffect(() => {
    if (!enabled || !gunReady || !owner || !see?.ready) return;
    const gun = gunRef.current;
    const acl = aclRef.current;
    if (!gun || !acl) return;
    const inbox = grantInboxRef(gun, owner, "rooms");
    if (!inbox?.map) return;
    let cancelled = false;
    const listener = inbox.map().on((data, key) => {
      if (cancelled) return;
      const graph = aclRef.current;
      if (!graph) return;
      const accepted = acceptGrantDelivery(graph, data, owner, Math.floor(Date.now() / 1000));
      if ("denied" in accepted) return;
      void persistRef.current?.();
      if ("retracted" in accepted) {
        setRooms((prev) => prev.filter((room) => room.id !== accepted.objectId && encodeKey(room.id) !== key));
        return;
      }
      if (accepted.kind === "room") setRooms((prev) => mergeRooms(prev, [accepted.room]));
    });
    return () => {
      cancelled = true;
      if (typeof listener.off === "function") listener.off();
    };
  }, [enabled, gunReady, owner, see?.ready]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch("/api/forum", { cache: "no-store" });
        if (cancelled) return;
        if (response.status === 401) {
          forumCache.current = [];
          setChannels([]);
          notify();
          return;
        }
        if (!response.ok) return;
        const parsed = readForumCatalog(await response.json());
        if (cancelled || !parsed) return;
        forumCache.current = parsed.messages;
        setChannels(parsed.channels);
        notify();
      } catch {
        // Keep the last read.
      }
    }
    void load();
    const id = window.setInterval(() => void load(), FORUM_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [enabled, notify]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch("/api/feed", { cache: "no-store" });
        if (cancelled || !response.ok) return;
        seedItems.current = readFeedItems(await response.json());
        if (!cancelled) rememberItems();
      } catch {
        // Keep the last snapshot.
      }
    }
    void load();
    const id = window.setInterval(() => void load(), FEED_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [enabled, rememberItems]);

  useEffect(() => {
    if (!enabled) return;
    const set = createSubscriptionSet((ref) => openRef.current(ref));
    subs.current = set;
    return () => {
      set.stopAll();
      if (subs.current === set) subs.current = null;
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      books.current.clear();
      fans.current.clear();
      setRows([]);
      return;
    }
    subs.current?.sync(sourcesRef.current);
    const keep = new Set(sourcesRef.current.map((ref) => formatCanonical(ref)));
    let changed = false;
    for (const key of [...books.current.keys()]) {
      if (keep.has(key)) continue;
      books.current.delete(key);
      changed = true;
    }
    if (changed) setRows(flattenBooks(books.current));
  }, [enabled, sourceKey, gunReady]);

  const unavailable = useCallback((): AccessState => ({ kind: "on-open" }), []);
  const access = useMemo(() => {
    if (!enabled || !see?.ready || !see.acl) return unavailable;
    const now = Math.floor(Date.now() / 1000);
    const graph = see.acl;
    return (ref: SourceRef) => sourceAccess(ref, { me: owner, selfNetwork: DEPLOYMENT_SELF_NETWORK, graph, now });
  }, [enabled, see?.ready, see?.acl, owner, checkedAt, graphEpoch, unavailable]);

  const catalog = useMemo(
    () => browseSources({ selfNetwork: DEPLOYMENT_SELF_NETWORK, rooms, channels, items }),
    [rooms, channels, items],
  );

  return useMemo(() => {
    if (!enabled) return IDLE;
    return { rows, access, sources: catalog, selfNetwork: DEPLOYMENT_SELF_NETWORK };
  }, [enabled, rows, access, catalog]);
}
