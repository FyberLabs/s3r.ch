"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FeedItem, FeedSnapshot, FeedTab } from "@/lib/feed-types";
import { fromGunNode, toGunNode } from "@/lib/feed-types";
import { mergeItems } from "@/lib/merge";
import {
  aggregateDiscoverTags,
  discoverCorpus,
  formatDiscoverTagQuery,
  parseDiscoverTagQuery,
} from "@/lib/feed-discover";
import { rankFeedItems } from "@/lib/feed-rank";
import {
  acceptLiveMeshWrite,
  emptyGrantedCopy,
  emptyNetworkCopy,
  itemsForTab,
} from "@/lib/feed-tabs";
import { ownsNativePost, prepareShareIntoMesh, prepareUnshareIntoMesh } from "@/lib/compose";
import { encodeKey } from "@/lib/identity/check";
import {
  dropRooms,
  fromGunRoomNode,
  itemsInRoom,
  mergeRooms,
  ownsRoom,
  prepareShareRoomIntoMesh,
  prepareUnshareRoomIntoMesh,
  rankRooms,
  roomsForTab,
  type Room,
} from "@/lib/rooms";
import {
  dropFeedItems,
  readUnshareId,
  ROOM_UNSHARE_COPY,
  UNSHARE_COPY,
} from "@/lib/unshare";
import {
  fromGunChatNode,
  mergeChat,
  messagesInRoom,
  preparePublishRoomChat,
  type ChatMessage,
} from "@/lib/chat";
import {
  fromGunPresenceNode,
  mergePresence,
  preparePublishRoomPresence,
  presenceInRoom,
  type PresenceEntry,
} from "@/lib/presence";
import {
  acceptGrantDelivery,
  grantInboxRef,
  type GrantInboxKind,
} from "@/lib/grant-delivery";
import { dropUsers, fromGunUserNode, mergeUsers, userProvenanceLine, type User } from "@/lib/users";
import { ComposeForm } from "@/components/ComposeForm";
import { DiscoverPanel } from "@/components/DiscoverPanel";
import { useGunPeer, type FeedGun } from "@/components/GunPeerProvider";
import { IngestForm } from "@/components/IngestForm";
import { PostSeeGrantControls } from "@/components/PostSeeGrantControls";
import { RoomSeeGrantControls } from "@/components/RoomSeeGrantControls";
import { RoomChat } from "@/components/RoomChat";
import { RoomPresence } from "@/components/RoomPresence";
import { RoomsList } from "@/components/RoomsList";
import { TagChips } from "@/components/TagChips";
import { useBrand } from "@/components/brand";
import { useSeeAcl } from "@/components/SeeAclProvider";
import { useIdentitySession } from "@/components/useIdentitySession";
import {
  browserGunOptions,
  feedStatusLine,
  listenThenConnectSeedPeer,
  TRYING_SEED_COPY,
  type SeedPeerEmitter,
} from "@/lib/gun-peer";
import { attachGunWebrtcLib } from "@/lib/gun-webrtc";
import {
  btnSecondary,
  btnTabOff,
  btnTabOn,
  failPanel,
  panel,
} from "@/lib/brand-ui";

type GunRef = SeedPeerEmitter & {
  get: (key: string) => GunRef;
  put: (data: unknown) => GunRef;
  map: () => { on: (cb: (data: unknown, key: string) => void) => { off?: () => void } };
};

function readDiscoverTagQuery(): string[] {
  if (typeof window === "undefined") return [];
  return parseDiscoverTagQuery(
    new URLSearchParams(window.location.search).get("tag"),
  );
}

function writeDiscoverTagQuery(tags: readonly string[]): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const formatted = formatDiscoverTagQuery(tags);
  if (formatted) url.searchParams.set("tag", formatted);
  else url.searchParams.delete("tag");
  const next = `${url.pathname}${url.search}${url.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next !== current) {
    window.history.replaceState(null, "", next);
  }
}

export function FeedStream() {
  const session = useIdentitySession();
  const see = useSeeAcl();
  const gunPeer = useGunPeer();
  const registerGun = gunPeer?.register;
  const gunRef = useRef<GunRef | null>(null);
  const seeRef = useRef(see);
  seeRef.current = see;
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const registerGunRef = useRef(registerGun);
  registerGunRef.current = registerGun;
  const [seed, setSeed] = useState<FeedItem[]>([]);
  const [overlay, setOverlay] = useState<FeedItem[]>([]);
  const [meshItems, setMeshItems] = useState<FeedItem[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [tab, setTab] = useState<FeedTab>("public");
  const [meta, setMeta] = useState<Omit<FeedSnapshot, "items"> | null>(null);
  const [status, setStatus] = useState(TRYING_SEED_COPY);
  const [sharedIds, setSharedIds] = useState<string[]>([]);
  const [confirmShareId, setConfirmShareId] = useState<string | null>(null);
  const [confirmUnshareId, setConfirmUnshareId] = useState<string | null>(null);
  const [shareMessage, setShareMessage] = useState<string | null>(null);
  const [mineRooms, setMineRooms] = useState<Room[]>([]);
  const [publicRooms, setPublicRooms] = useState<Room[]>([]);
  const [meshRooms, setMeshRooms] = useState<Room[]>([]);
  const [openRoomId, setOpenRoomId] = useState<string | null>(null);
  const [sharedRoomIds, setSharedRoomIds] = useState<string[]>([]);
  const [confirmShareRoomId, setConfirmShareRoomId] = useState<string | null>(
    null,
  );
  const [confirmUnshareRoomId, setConfirmUnshareRoomId] = useState<string | null>(
    null,
  );
  const [roomShareMessage, setRoomShareMessage] = useState<string | null>(null);
  const [overlayChat, setOverlayChat] = useState<ChatMessage[]>([]);
  const [graphChat, setGraphChat] = useState<ChatMessage[]>([]);
  const [overlayPresence, setOverlayPresence] = useState<PresenceEntry[]>([]);
  const [graphPresence, setGraphPresence] = useState<PresenceEntry[]>([]);
  const [meshUsers, setMeshUsers] = useState<User[]>([]);
  const [grantedItems, setGrantedItems] = useState<FeedItem[]>([]);
  const [grantedRooms, setGrantedRooms] = useState<Room[]>([]);
  const [grantedUsers, setGrantedUsers] = useState<User[]>([]);
  const [gunReady, setGunReady] = useState(false);
  const [seedWsUp, setSeedWsUp] = useState(false);
  const seedWsUpRef = useRef(false);
  const heardItemsRef = useRef<FeedItem[]>([]);
  const heardRoomsRef = useRef<Room[]>([]);

  const hydrate = useCallback(async (gun: GunRef, items: FeedItem[]) => {
    for (const item of items) {
      gun.get("s3rch").get("items").get(encodeKey(item.id)).put(toGunNode(item));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let off: (() => void) | undefined;
    let offRooms: (() => void) | undefined;
    let offUsers: (() => void) | undefined;

    (async () => {
      const GunMod = await import("gun/browser");
      const Gun = (GunMod.default ?? GunMod) as unknown as (opts?: object) => GunRef;
      // gun/lib/webrtc hooks Gun.on('opt') and must load before construct.
      // STUN only. If RTC is missing or ICE fails, seed / snapshot stay.
      // Listen for mesh hi/bye on gun._.on, then opt the same-origin /gun
      // peer. Constructing with peers can fire hi before the listener.
      // No user.recall. See docs/ARCHITECTURE.md.
      const webrtcAttempted = await attachGunWebrtcLib(Gun);
      const gun = Gun(browserGunOptions());
      gunRef.current = gun;
      registerGunRef.current?.(gun as unknown as FeedGun);
      if (!cancelled) setGunReady(true);
      let seedWsUp = false;
      let snapshotEmpty = true;
      listenThenConnectSeedPeer(gun, window.location.origin, (up) => {
        seedWsUp = up;
        seedWsUpRef.current = up;
        if (!cancelled) {
          setSeedWsUp(up);
          setStatus(feedStatusLine(up, snapshotEmpty, webrtcAttempted));
        }
      });

      let snapshot: FeedSnapshot = {
        items: [],
        seededAt: null,
        sourcesOk: 0,
        sourcesTried: 0,
        error: null,
      };
      try {
        const response = await fetch("/api/feed", { cache: "no-store" });
        snapshot = (await response.json()) as FeedSnapshot;
      } catch {
        snapshot.error = "Could not read the Gun snapshot.";
      }
      if (cancelled) return;

      setMeta({
        seededAt: snapshot.seededAt,
        sourcesOk: snapshot.sourcesOk,
        sourcesTried: snapshot.sourcesTried,
        error: snapshot.error,
      });
      // Snapshot paints Public even if /gun WS never comes up. Network
      // does not take these rows — only Gun .map().on while the seed
      // peer is up (keep last mesh rows after a brief bye).
      const snapItems = snapshot.items ?? [];
      snapshotEmpty = snapItems.length === 0;
      setSeed((prev) => mergeItems(prev, snapItems));
      await hydrate(gun, snapItems);

      const listener = gun.get("s3rch").get("items").map().on((data, key) => {
        if (cancelled) return;
        const unsharedId = readUnshareId(data, key);
        if (unsharedId) {
          setSeed((prev) => dropFeedItems(prev, unsharedId));
          heardItemsRef.current = dropFeedItems(heardItemsRef.current, unsharedId);
          if (acceptLiveMeshWrite(seedWsUpRef.current)) {
            setMeshItems(heardItemsRef.current);
          }
          setSharedIds((prev) =>
            prev.filter((id) => id !== unsharedId && id !== key),
          );
          return;
        }
        const item = fromGunNode(
          data as Parameters<typeof fromGunNode>[0],
        );
        if (!item) return;
        setSeed((prev) => mergeItems(prev, [item]));
        heardItemsRef.current = mergeItems(heardItemsRef.current, [item]);
        if (acceptLiveMeshWrite(seedWsUpRef.current)) {
          setMeshItems(heardItemsRef.current);
        }
      });
      off = typeof listener?.off === "function" ? () => listener.off?.() : undefined;

      const roomsListener = gun.get("s3rch").get("rooms").map().on((data, key) => {
        if (cancelled) return;
        const unsharedId = readUnshareId(data, key);
        if (unsharedId) {
          setPublicRooms((prev) => dropRooms(prev, unsharedId));
          heardRoomsRef.current = dropRooms(heardRoomsRef.current, unsharedId);
          if (acceptLiveMeshWrite(seedWsUpRef.current)) {
            setMeshRooms(heardRoomsRef.current);
          }
          setSharedRoomIds((prev) =>
            prev.filter((id) => id !== unsharedId && id !== key),
          );
          setGraphChat((prev) => prev.filter((row) => row.room !== unsharedId));
          setGraphPresence((prev) => prev.filter((row) => row.room !== unsharedId));
          return;
        }
        const room = fromGunRoomNode(
          data as Parameters<typeof fromGunRoomNode>[0],
        );
        if (!room) return;
        setPublicRooms((prev) => mergeRooms(prev, [room]));
        heardRoomsRef.current = mergeRooms(heardRoomsRef.current, [room]);
        if (acceptLiveMeshWrite(seedWsUpRef.current)) {
          setMeshRooms(heardRoomsRef.current);
        }
      });
      offRooms =
        typeof roomsListener?.off === "function"
          ? () => roomsListener.off?.()
          : undefined;

      const usersListener = gun.get("s3rch").get("users").map().on((data, key) => {
        if (cancelled) return;
        const unsharedId = readUnshareId(data, key);
        if (unsharedId) {
          setMeshUsers((prev) => dropUsers(prev, unsharedId));
          return;
        }
        const user = fromGunUserNode(
          data as Parameters<typeof fromGunUserNode>[0],
        );
        if (!user) return;
        setMeshUsers((prev) => mergeUsers(prev, [user]));
      });
      offUsers =
        typeof usersListener?.off === "function"
          ? () => usersListener.off?.()
          : undefined;

      // seedWsUp stays source of truth. A later hi must not be clobbered
      // by this snapshot paint; an earlier hi already set it.
      if (!cancelled) {
        seedWsUpRef.current = seedWsUp;
        setSeedWsUp(seedWsUp);
        setStatus(feedStatusLine(seedWsUp, snapshotEmpty, webrtcAttempted));
      }
    })();

    return () => {
      cancelled = true;
      off?.();
      offRooms?.();
      offUsers?.();
      registerGunRef.current?.(null);
    };
  }, [hydrate]);

  useEffect(() => {
    seedWsUpRef.current = seedWsUp;
    if (!acceptLiveMeshWrite(seedWsUp)) return;
    // Promote Gun-heard rows (not snapshot-only seed) once the wire is up.
    setMeshItems(heardItemsRef.current);
    setMeshRooms(heardRoomsRef.current);
  }, [seedWsUp]);

  useEffect(() => {
    const gun = gunRef.current;
    const address = session?.address;
    if (!gun || !gunReady || !address || !see?.ready) {
      setGrantedItems([]);
      setGrantedRooms([]);
      setGrantedUsers([]);
      return;
    }
    let cancelled = false;
    const kinds: GrantInboxKind[] = ["items", "rooms", "users"];
    const offs: Array<() => void> = [];

    const ingest = (kind: GrantInboxKind, data: unknown, key: string) => {
      const acl = seeRef.current?.acl;
      const who = sessionRef.current?.address;
      if (!acl || !who || cancelled) return;
      const now = Math.floor(Date.now() / 1000);
      if (data == null) {
        if (kind === "items") {
          setGrantedItems((prev) => prev.filter((row) => encodeKey(row.id) !== key));
        } else if (kind === "rooms") {
          setGrantedRooms((prev) => prev.filter((row) => encodeKey(row.id) !== key));
        } else {
          setGrantedUsers((prev) =>
            prev.filter(
              (row) =>
                encodeKey(row.id) !== key &&
                !row.indicators.some((claim) => encodeKey(claim) === key),
            ),
          );
        }
        return;
      }
      const accepted = acceptGrantDelivery(acl, data, who, now);
      if ("denied" in accepted) return;
      void seeRef.current?.persist();
      if ("retracted" in accepted) {
        if (accepted.kind === "item") {
          setGrantedItems((prev) =>
            prev.filter((row) => row.id !== accepted.objectId),
          );
        } else if (accepted.kind === "room") {
          setGrantedRooms((prev) =>
            prev.filter((row) => row.id !== accepted.objectId),
          );
        } else {
          setGrantedUsers((prev) =>
            prev.filter(
              (row) =>
                row.id !== accepted.objectId &&
                !row.indicators.some((claim) => claim === accepted.objectId),
            ),
          );
        }
        return;
      }
      if (accepted.kind === "item") {
        setGrantedItems((prev) => mergeItems(prev, [accepted.item]));
      } else if (accepted.kind === "room") {
        setGrantedRooms((prev) => mergeRooms(prev, [accepted.room]));
      } else {
        setGrantedUsers((prev) => mergeUsers(prev, [accepted.user]));
      }
    };

    for (const kind of kinds) {
      const inbox = grantInboxRef(gun, address, kind);
      if (!inbox) continue;
      const listener = inbox.map?.().on((data, key) => ingest(kind, data, key));
      if (typeof listener?.off === "function") {
        offs.push(() => listener.off?.());
      }
    }

    return () => {
      cancelled = true;
      for (const off of offs) off();
    };
  }, [gunReady, session?.address, see?.ready]);

  useEffect(() => {
    setSelected(readDiscoverTagQuery());
  }, []);

  const tabRooms = useMemo(
    () => roomsForTab(tab, publicRooms, mineRooms, meshRooms, grantedRooms),
    [tab, publicRooms, mineRooms, meshRooms, grantedRooms],
  );
  const listedRooms = useMemo(
    () => rankRooms(tabRooms, selected),
    [tabRooms, selected],
  );
  const openRoom = useMemo(
    () =>
      listedRooms.find((room) => room.id === openRoomId) ??
      tabRooms.find((room) => room.id === openRoomId) ??
      null,
    [listedRooms, tabRooms, openRoomId],
  );

  const tabItems = useMemo(
    () => itemsForTab(tab, seed, overlay, meshItems, grantedItems),
    [tab, seed, overlay, meshItems, grantedItems],
  );
  const hasMeshRows = meshItems.length > 0 || meshRooms.length > 0;
  const hasGrantedRows =
    grantedItems.length > 0 || grantedRooms.length > 0 || grantedUsers.length > 0;
  const threadItems = useMemo(
    () => (openRoom ? itemsInRoom(tabItems, openRoom.id) : tabItems),
    [openRoom, tabItems],
  );
  const tags = useMemo(() => {
    const set = new Set<string>();
    for (const item of threadItems) {
      for (const tag of item.tags) set.add(tag);
    }
    for (const room of tabRooms) {
      for (const tag of room.tags) set.add(tag);
    }
    return Array.from(set).sort();
  }, [threadItems, tabRooms]);

  const discovery = useMemo(() => {
    const corpus = discoverCorpus({
      publicItems: itemsForTab("public", seed, overlay, meshItems),
      publicRooms: roomsForTab("public", publicRooms, mineRooms, meshRooms),
      networkItems: itemsForTab("network", seed, overlay, meshItems),
      networkRooms: roomsForTab("network", publicRooms, mineRooms, meshRooms),
    });
    return {
      tags: aggregateDiscoverTags(corpus.items, corpus.rooms),
      rooms: rankRooms(corpus.rooms, selected),
    };
  }, [seed, overlay, meshItems, publicRooms, mineRooms, meshRooms, selected]);

  const visible = useMemo(
    () => rankFeedItems(threadItems, selected),
    [threadItems, selected],
  );

  const published = useMemo(() => {
    const ids = new Set(sharedIds);
    for (const item of seed) ids.add(item.id);
    return ids;
  }, [seed, sharedIds]);

  const publishedRooms = useMemo(() => {
    const ids = new Set(sharedRoomIds);
    for (const room of publicRooms) ids.add(room.id);
    return ids;
  }, [publicRooms, sharedRoomIds]);

  const openRoomIsPublic = Boolean(openRoomId && publishedRooms.has(openRoomId));

  useEffect(() => {
    const gun = gunRef.current;
    if (!gun || !gunReady || !openRoomId || !openRoomIsPublic) return;
    const roomId = openRoomId;
    let cancelled = false;
    const listener = gun
      .get("s3rch")
      .get("rooms")
      .get(encodeKey(roomId))
      .get("chat")
      .map()
      .on((data) => {
        const message = fromGunChatNode(
          data as Parameters<typeof fromGunChatNode>[0],
        );
        if (!message || cancelled || message.room !== roomId) return;
        setGraphChat((prev) => mergeChat(prev, [message]));
      });
    return () => {
      cancelled = true;
      if (typeof listener?.off === "function") listener.off();
    };
  }, [gunReady, openRoomId, openRoomIsPublic]);

  useEffect(() => {
    const gun = gunRef.current;
    if (!gun || !gunReady || !openRoomId || !openRoomIsPublic) return;
    const roomId = openRoomId;
    let cancelled = false;
    const listener = gun
      .get("s3rch")
      .get("rooms")
      .get(encodeKey(roomId))
      .get("presence")
      .map()
      .on((data) => {
        const row = fromGunPresenceNode(
          data as Parameters<typeof fromGunPresenceNode>[0],
        );
        if (!row || cancelled || row.room !== roomId) return;
        setGraphPresence((prev) => mergePresence(prev, [row]));
      });
    return () => {
      cancelled = true;
      if (typeof listener?.off === "function") listener.off();
    };
  }, [gunReady, openRoomId, openRoomIsPublic]);

  const openRoomChat = useMemo(() => {
    if (!openRoomId) return [];
    return messagesInRoom(mergeChat(graphChat, overlayChat), openRoomId);
  }, [openRoomId, graphChat, overlayChat]);

  const openRoomPresence = useMemo(() => {
    if (!openRoomId) return [];
    return presenceInRoom(
      mergePresence(graphPresence, overlayPresence),
      openRoomId,
    );
  }, [openRoomId, graphPresence, overlayPresence]);

  const publishedRoomsRef = useRef(publishedRooms);
  publishedRoomsRef.current = publishedRooms;

  const announcePresence = useCallback(
    (entry: PresenceEntry, putOnGun: boolean) => {
      setOverlayPresence((prev) => mergePresence(prev, [entry]));
      if (!putOnGun) return;
      const acl = seeRef.current?.acl;
      const address = sessionRef.current?.address;
      const gun = gunRef.current;
      if (!acl || !address || !gun) return;
      const prepared = preparePublishRoomPresence(
        acl,
        entry,
        address,
        publishedRoomsRef.current,
      );
      if ("denied" in prepared) return;
      gun
        .get("s3rch")
        .get("rooms")
        .get(prepared.roomKey)
        .get("presence")
        .get(prepared.key)
        .put(prepared.node);
    },
    [],
  );

  function selectTab(next: FeedTab) {
    setTab(next);
    setSelected([]);
    writeDiscoverTagQuery([]);
    setShareMessage(null);
    setConfirmShareId(null);
    setConfirmUnshareId(null);
    setOpenRoomId(null);
    setRoomShareMessage(null);
    setConfirmShareRoomId(null);
    setConfirmUnshareRoomId(null);
  }

  function applyDiscoverTags(next: string[]) {
    setSelected(next);
    writeDiscoverTagQuery(next);
    setOpenRoomId(null);
    setRoomShareMessage(null);
    setConfirmShareRoomId(null);
    setConfirmUnshareRoomId(null);
    if (tab === "mine") setTab("public");
  }

  async function shareToPublic(item: FeedItem) {
    setShareMessage(null);
    if (!session || !see?.acl) {
      setShareMessage("Could not share this post.");
      return;
    }
    if (confirmShareId !== item.id) {
      setConfirmShareId(item.id);
      return;
    }
    const prepared = prepareShareIntoMesh(see.acl, item, session.address);
    if ("denied" in prepared) {
      setShareMessage("Could not admit this post.");
      setConfirmShareId(null);
      return;
    }
    const gun = gunRef.current;
    if (!gun) {
      setShareMessage("Gun is not open yet.");
      return;
    }
    gun.get("s3rch").get("items").get(prepared.key).put(prepared.node);
    setSharedIds((prev) => (prev.includes(item.id) ? prev : [...prev, item.id]));
    setConfirmShareId(null);
    setShareMessage(
      `Published to the public graph. ${UNSHARE_COPY}`,
    );
    await see.persist();
  }

  async function unshareFromPublic(item: FeedItem) {
    setShareMessage(null);
    if (!session || !see?.acl) {
      setShareMessage("Could not unshare this post.");
      return;
    }
    if (confirmUnshareId !== item.id) {
      setConfirmUnshareId(item.id);
      setConfirmShareId(null);
      return;
    }
    const prepared = prepareUnshareIntoMesh(see.acl, item, session.address);
    if ("denied" in prepared) {
      setShareMessage("Could not unshare this post.");
      setConfirmUnshareId(null);
      return;
    }
    const gun = gunRef.current;
    if (!gun) {
      setShareMessage("Gun is not open yet.");
      return;
    }
    gun.get("s3rch").get("items").get(prepared.key).put(prepared.tombstone);
    setSharedIds((prev) => prev.filter((id) => id !== item.id));
    setSeed((prev) => dropFeedItems(prev, item.id));
    heardItemsRef.current = dropFeedItems(heardItemsRef.current, item.id);
    setMeshItems(heardItemsRef.current);
    setConfirmUnshareId(null);
    setShareMessage(UNSHARE_COPY);
  }

  async function shareRoomToPublic(room: Room) {
    setRoomShareMessage(null);
    if (!session || !see?.acl) {
      setRoomShareMessage("Could not share this room.");
      return;
    }
    if (confirmShareRoomId !== room.id) {
      setConfirmShareRoomId(room.id);
      return;
    }
    const prepared = prepareShareRoomIntoMesh(see.acl, room, session.address);
    if ("denied" in prepared) {
      setRoomShareMessage("Could not admit this room.");
      setConfirmShareRoomId(null);
      return;
    }
    const gun = gunRef.current;
    if (!gun) {
      setRoomShareMessage("Gun is not open yet.");
      return;
    }
    gun.get("s3rch").get("rooms").get(prepared.key).put(prepared.node);
    setSharedRoomIds((prev) =>
      prev.includes(room.id) ? prev : [...prev, room.id],
    );
    const publicIds = new Set(publishedRooms);
    publicIds.add(room.id);
    for (const row of overlayChat) {
      if (row.room !== room.id) continue;
      const preparedChat = preparePublishRoomChat(
        see.acl,
        row,
        session.address,
        publicIds,
      );
      if ("denied" in preparedChat) continue;
      gun
        .get("s3rch")
        .get("rooms")
        .get(preparedChat.roomKey)
        .get("chat")
        .get(preparedChat.key)
        .put(preparedChat.node);
    }
    for (const row of overlayPresence) {
      if (row.room !== room.id) continue;
      const preparedPresence = preparePublishRoomPresence(
        see.acl,
        row,
        session.address,
        publicIds,
      );
      if ("denied" in preparedPresence) continue;
      gun
        .get("s3rch")
        .get("rooms")
        .get(preparedPresence.roomKey)
        .get("presence")
        .get(preparedPresence.key)
        .put(preparedPresence.node);
    }
    setConfirmShareRoomId(null);
    setRoomShareMessage(
      `Published this room node to the public graph. Posts inside stay Mine until you share those posts. ${ROOM_UNSHARE_COPY}`,
    );
    await see.persist();
  }

  async function unshareRoomFromPublic(room: Room) {
    setRoomShareMessage(null);
    if (!session || !see?.acl) {
      setRoomShareMessage("Could not unshare this room.");
      return;
    }
    if (confirmUnshareRoomId !== room.id) {
      setConfirmUnshareRoomId(room.id);
      setConfirmShareRoomId(null);
      return;
    }
    const prepared = prepareUnshareRoomIntoMesh(see.acl, room, session.address);
    if ("denied" in prepared) {
      setRoomShareMessage("Could not unshare this room.");
      setConfirmUnshareRoomId(null);
      return;
    }
    const gun = gunRef.current;
    if (!gun) {
      setRoomShareMessage("Gun is not open yet.");
      return;
    }
    gun.get("s3rch").get("rooms").get(prepared.key).put(prepared.tombstone);
    setSharedRoomIds((prev) => prev.filter((id) => id !== room.id));
    setPublicRooms((prev) => dropRooms(prev, room.id));
    heardRoomsRef.current = dropRooms(heardRoomsRef.current, room.id);
    setMeshRooms(heardRoomsRef.current);
    setGraphChat((prev) => prev.filter((row) => row.room !== room.id));
    setGraphPresence((prev) => prev.filter((row) => row.room !== room.id));
    setConfirmUnshareRoomId(null);
    setRoomShareMessage(ROOM_UNSHARE_COPY);
  }

  const composeRoomId =
    tab === "mine" && openRoom && ownsRoom(openRoom, session?.address)
      ? openRoom.id
      : undefined;

  return (
    <div>
      <p className="mt-6 text-xs text-ink-muted">
        {status}
        {meta?.seededAt ? ` · seeded ${meta.seededAt}` : ""}
        {meta
          ? ` · sources ${meta.sourcesOk} / ${meta.sourcesTried}`
          : ""}
      </p>
      {meta?.error ? (
        <div className={`mt-6 ${failPanel}`}>
          <p className="font-semibold">Seed is empty or failed</p>
          <p className="mt-2">{meta.error}</p>
          <p className="mt-2">
            No rows were invented. The Gun graph only holds what the seeder wrote.
          </p>
        </div>
      ) : null}

      {tab !== "network" && tab !== "granted" && !composeRoomId ? (
        <ComposeForm
          onItem={(next) => setOverlay((prev) => mergeItems(prev, [next]))}
        />
      ) : null}

      <div className="mt-8 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => selectTab("public")}
          className={tab === "public" ? btnTabOn : btnTabOff}
        >
          Public
        </button>
        <button
          type="button"
          onClick={() => selectTab("mine")}
          className={tab === "mine" ? btnTabOn : btnTabOff}
        >
          Mine
        </button>
        <button
          type="button"
          onClick={() => selectTab("network")}
          className={tab === "network" ? btnTabOn : btnTabOff}
        >
          Network
        </button>
        <button
          type="button"
          onClick={() => selectTab("granted")}
          className={tab === "granted" ? btnTabOn : btnTabOff}
        >
          Granted
        </button>
      </div>
      {tab === "network" ? (
        <p className="mt-2 text-xs text-ink-muted">
          Live mesh via the seed peer and WebRTC when ICE works. STUN is
          not TURN. This is not a finished P2P mesh. Meetings and streams
          are later. Mine overlay and ingest stay off this tab.
        </p>
      ) : null}
      {tab === "granted" ? (
        <p className="mt-2 text-xs text-ink-muted">
          Objects delivered to you by a live see-grant. Gun-stored posts,
          rooms, and claims only — URL fetches stay handoffs. Not Public,
          not Network, not search. First delivery can wait on the mesh.
          Revoke is immediate on dest ACL. Unshare tombstones still hide
          retracted public puts; this inbox does not write those paths.
        </p>
      ) : null}

      {tab === "granted" && grantedUsers.length > 0 ? (
        <div className={`mt-6 ${panel}`}>
          <h2 className="text-sm font-semibold text-ink">Granted claims</h2>
          <p className="mt-2 text-xs text-ink-muted">
            User-node claims delivered to you. Not a Popular list and not
            the holder&apos;s private footprint.
          </p>
          <ul className="mt-3 space-y-2 text-xs text-ink-muted">
            {grantedUsers.map((user) => (
              <li key={user.id}>{userProvenanceLine(user)}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {tab !== "mine" && tab !== "granted" ? (
        <DiscoverPanel
          tags={discovery.tags}
          rooms={discovery.rooms}
          users={meshUsers}
          selected={selected}
          selectedRoomId={openRoomId}
          onChange={applyDiscoverTags}
          onOpenRoom={(room) => {
            setOpenRoomId((current) => (current === room.id ? null : room.id));
            setRoomShareMessage(null);
            setConfirmShareRoomId(null);
            setConfirmUnshareRoomId(null);
          }}
        />
      ) : null}

      <RoomsList
        rooms={listedRooms}
        selectedId={openRoomId}
        onSelect={(room) => {
          setOpenRoomId(room?.id ?? null);
          setRoomShareMessage(null);
          setConfirmShareRoomId(null);
          setConfirmUnshareRoomId(null);
        }}
        canCreate={tab === "mine" && Boolean(session)}
        showCreateHint={tab === "mine" && !session}
        emptyHint={
          tab === "network"
            ? !seedWsUp && !hasMeshRows
              ? emptyNetworkCopy({
                  tagged: false,
                  inRoom: false,
                  seedWsUp,
                  hasMeshRows,
                })
              : "No shared rooms on the live mesh."
            : tab === "granted"
              ? !session
                ? "Sign in to receive granted rooms."
                : "No granted rooms yet. Granting a room does not deliver Mine posts inside it."
              : undefined
        }
        showOwner={tab === "public" || tab === "network" || tab === "granted"}
        onCreated={(room) => {
          setMineRooms((prev) => mergeRooms(prev, [room]));
          setOpenRoomId(room.id);
        }}
      />

      {openRoom ? (
        <RoomThreadHeader
          room={openRoom}
        mine={tab === "mine"}
        network={tab === "network"}
        granted={tab === "granted"}
          owned={ownsRoom(openRoom, session?.address)}
          shared={publishedRooms.has(openRoom.id)}
          confirmShare={confirmShareRoomId === openRoom.id}
          confirmUnshare={confirmUnshareRoomId === openRoom.id}
          shareMessage={roomShareMessage}
          sessionAddress={session?.address ?? null}
          onClose={() => {
            setOpenRoomId(null);
            setRoomShareMessage(null);
            setConfirmShareRoomId(null);
            setConfirmUnshareRoomId(null);
          }}
          onShare={() => void shareRoomToPublic(openRoom)}
          onUnshare={() => void unshareRoomFromPublic(openRoom)}
        />
      ) : null}

      {openRoom ? (
        <RoomPresence
          roomId={openRoom.id}
          entries={openRoomPresence}
          onPublicGraph={openRoomIsPublic}
          seedWsUp={seedWsUp}
          onAnnounced={announcePresence}
        />
      ) : null}

      {openRoom ? (
        <RoomChat
          roomId={openRoom.id}
          messages={openRoomChat}
          onPublicGraph={openRoomIsPublic}
          seedWsUp={seedWsUp}
          onComposed={(next, putOnGun) => {
            setOverlayChat((prev) => mergeChat(prev, [next]));
            if (!putOnGun || !see?.acl || !session) return;
            const gun = gunRef.current;
            if (!gun) return;
            const prepared = preparePublishRoomChat(
              see.acl,
              next,
              session.address,
              publishedRooms,
            );
            if ("denied" in prepared) return;
            gun
              .get("s3rch")
              .get("rooms")
              .get(prepared.roomKey)
              .get("chat")
              .get(prepared.key)
              .put(prepared.node);
          }}
        />
      ) : null}

      {composeRoomId ? (
        <ComposeForm
          roomId={composeRoomId}
          onItem={(next) => setOverlay((prev) => mergeItems(prev, [next]))}
        />
      ) : null}

      {tab === "mine" || tab === "granted" ? (
        <TagChips tags={tags} selected={selected} onChange={setSelected} />
      ) : null}

      {shareMessage && tab === "mine" ? (
        <p className="mt-3 text-xs text-ink-muted">{shareMessage}</p>
      ) : null}

      {visible.length === 0 ? (
        <p className="mt-8 border border-rule bg-panel p-6 text-sm text-ink-muted">
          {emptyCopy(
            tab,
            Boolean(session),
            selected.length > 0,
            Boolean(openRoom),
            seedWsUp,
            hasMeshRows,
            hasGrantedRows,
          )}
        </p>
      ) : (
        <FeedItems
          items={visible}
          mine={tab === "mine"}
          sessionAddress={session?.address ?? null}
          published={published}
          confirmShareId={confirmShareId}
          confirmUnshareId={confirmUnshareId}
          onShare={(item) => void shareToPublic(item)}
          onUnshare={(item) => void unshareFromPublic(item)}
        />
      )}

      {tab === "mine" ? (
        <IngestForm
          onItems={(next) => setOverlay((prev) => mergeItems(prev, next))}
        />
      ) : null}
    </div>
  );
}

function emptyCopy(
  tab: FeedTab,
  signedIn: boolean,
  tagged: boolean,
  inRoom: boolean,
  seedWsUp: boolean,
  hasMeshRows: boolean,
  hasGrantedRows: boolean,
): string {
  if (tab === "granted") {
    return emptyGrantedCopy({
      signedIn,
      tagged,
      inRoom,
      seedWsUp,
      hasGrantedRows,
    });
  }
  if (tab === "network") {
    return emptyNetworkCopy({ tagged, inRoom, seedWsUp, hasMeshRows });
  }
  if (inRoom && tab === "mine") {
    return tagged
      ? "No Mine posts in this room for the selected tags."
      : "This room has no Mine posts yet. Compose into it. Sharing the room does not publish these posts.";
  }
  if (inRoom) {
    return tagged
      ? "No public posts in this room for the selected tags."
      : "This shared room has no public posts yet. Sharing the room does not publish Mine posts inside it.";
  }
  if (tab === "mine" && !signedIn) {
    return "Mine is empty until you sign in. Overlay ingest and native posts stay here; they are not the public seed.";
  }
  if (tab === "mine") {
    return tagged
      ? "No Mine items for the selected tags."
      : "Mine is empty. Compose a native post or pull a URL into your overlay. Nothing was invented.";
  }
  return tagged
    ? "No items in this Gun graph for the selected tags. Empty sources stay empty."
    : "No items in this Gun graph. Empty sources stay empty.";
}

function RoomThreadHeader({
  room,
  mine,
  network,
  granted,
  owned,
  shared,
  confirmShare,
  confirmUnshare,
  shareMessage,
  sessionAddress,
  onClose,
  onShare,
  onUnshare,
}: {
  room: Room;
  mine: boolean;
  network: boolean;
  granted?: boolean;
  owned: boolean;
  shared: boolean;
  confirmShare: boolean;
  confirmUnshare: boolean;
  shareMessage: string | null;
  sessionAddress: string | null;
  onClose: () => void;
  onShare: () => void;
  onUnshare: () => void;
}) {
  return (
    <div className={`mt-6 ${panel}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-signal">
            Room thread
          </p>
          <h2 className="mt-1 text-base font-semibold text-ink">
            {room.title}
          </h2>
          <p className="mt-1 text-xs text-ink-muted">{room.tags.join(" · ")}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className={btnSecondary}
        >
          Close thread
        </button>
      </div>
      <p className="mt-3 text-xs text-ink-muted">
        Posts belong by tag. Live chat and presence are this pass (Gun
        subscribe on the room). WebRTC is attempted over STUN when ICE
        works; STUN is not TURN. Meetings and streams are later.
        {granted
          ? " This room was delivered by a see-grant. It is not Public. Chat and presence stay on the public room graph only if that room was shared."
          : network
            ? " Network is the live mesh view via the seed peer / WebRTC — not the snapshot."
            : " Trying seed peer; snapshot if the socket is down. Snapshot is not a chat log or a presence list."}
      </p>
      {mine && owned && sessionAddress ? (
        <div className="mt-3 border-t border-rule pt-3">
          {shared ? (
            <>
              <p className="text-xs text-ink-muted">
                This room node is on the public graph. Posts inside stay Mine
                until you share those posts. {ROOM_UNSHARE_COPY}
              </p>
              <button
                type="button"
                onClick={onUnshare}
                className={`mt-2 ${btnSecondary}`}
              >
                {confirmUnshare ? "Confirm unshare" : "Unshare from public"}
              </button>
            </>
          ) : (
            <>
              <p className="text-xs text-ink-muted">
                Share to public publishes this room node onto the public rooms
                graph. It does not publish Mine posts inside it. A see-grant is
                not this. {ROOM_UNSHARE_COPY}
              </p>
              <button
                type="button"
                onClick={onShare}
                className={`mt-2 ${btnSecondary}`}
              >
                {confirmShare ? "Confirm share" : "Share to public"}
              </button>
            </>
          )}
          {shareMessage ? (
            <p className="mt-2 text-xs text-ink-muted">{shareMessage}</p>
          ) : null}
          <RoomSeeGrantControls address={sessionAddress} room={room} />
        </div>
      ) : null}
    </div>
  );
}

function formatIso(ts: number): string {
  if (!ts) return "";
  return new Date(ts * 1000).toISOString().replace(".000Z", "Z");
}

function FeedItems({
  items,
  mine,
  sessionAddress,
  published,
  confirmShareId,
  confirmUnshareId,
  onShare,
  onUnshare,
}: {
  items: FeedItem[];
  mine: boolean;
  sessionAddress: string | null;
  published: Set<string>;
  confirmShareId: string | null;
  confirmUnshareId: string | null;
  onShare: (item: FeedItem) => void;
  onUnshare: (item: FeedItem) => void;
}) {
  const { reader } = useBrand();
  if (reader === "ai") {
    return (
      <div className="mt-8 overflow-x-auto">
        <table className="brand-table">
          <thead>
            <tr>
              <th scope="col">author</th>
              <th scope="col">kind</th>
              <th scope="col">body</th>
              <th scope="col">tags</th>
              <th scope="col">ts</th>
              <th scope="col">provenance</th>
              <th scope="col">permalink</th>
              {mine ? <th scope="col">share</th> : null}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const ownNative = mine && ownsNativePost(item, sessionAddress);
              const shared = published.has(item.id);
              return (
                <tr key={item.id}>
                  <td className="font-data">{item.author || ""}</td>
                  <td>{item.kind}</td>
                  <td className="whitespace-normal">{item.body}</td>
                  <td className="whitespace-normal">{item.tags.join(",")}</td>
                  <td className="font-data">{formatIso(item.ts)}</td>
                  <td className="whitespace-normal">{item.provenance}</td>
                  <td>
                    {item.permalink ? (
                      <a
                        href={item.permalink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-ink hover:text-signal"
                      >
                        href
                      </a>
                    ) : (
                      ""
                    )}
                  </td>
                  {mine ? (
                    <td>
                      {ownNative && sessionAddress ? (
                        <button
                          type="button"
                          onClick={() => (shared ? onUnshare(item) : onShare(item))}
                          className={btnSecondary}
                        >
                          {shared
                            ? confirmUnshareId === item.id
                              ? "Confirm unshare"
                              : "Unshare"
                            : confirmShareId === item.id
                              ? "Confirm share"
                              : "Share"}
                        </button>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
        {mine && sessionAddress
          ? items
              .filter((item) => ownsNativePost(item, sessionAddress))
              .map((item) => (
                <PostSeeGrantControls
                  key={`grant-${item.id}`}
                  address={sessionAddress}
                  itemId={item.id}
                />
              ))
          : null}
      </div>
    );
  }

  return (
    <ul className="mt-8 space-y-3">
      {items.map((item) => (
        <li key={item.id}>
          <FeedCard
            item={item}
            mine={mine}
            sessionAddress={sessionAddress}
            shared={published.has(item.id)}
            confirmShare={confirmShareId === item.id}
            confirmUnshare={confirmUnshareId === item.id}
            onShare={() => onShare(item)}
            onUnshare={() => onUnshare(item)}
          />
        </li>
      ))}
    </ul>
  );
}

function FeedCard({
  item,
  mine,
  sessionAddress,
  shared,
  confirmShare,
  confirmUnshare,
  onShare,
  onUnshare,
}: {
  item: FeedItem;
  mine: boolean;
  sessionAddress: string | null;
  shared: boolean;
  confirmShare: boolean;
  confirmUnshare: boolean;
  onShare: () => void;
  onUnshare: () => void;
}) {
  const when = item.ts
    ? new Date(item.ts * 1000).toISOString().replace(".000Z", "Z")
    : null;
  const ownNative = mine && ownsNativePost(item, sessionAddress);
  const inner = (
    <>
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-base font-semibold text-ink">
          {item.author || item.kind}
        </h2>
        <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-signal">
          {item.kind}
        </span>
      </div>
      <p className="mt-1 text-sm text-ink-muted">{item.body}</p>
      <p className="mt-2 text-xs text-ink-muted">
        {item.tags.join(" · ")}
        {when ? ` · ${when}` : ""}
        {item.provenance ? ` · ${item.provenance}` : ""}
      </p>
    </>
  );
  const className =
    "block border border-rule bg-panel p-5";

  if (ownNative && sessionAddress) {
    return (
      <div className={className}>
        {inner}
        <div className="mt-3 border-t border-rule pt-3">
          {shared ? (
            <>
              <p className="text-xs text-ink-muted">
                On the public graph. {UNSHARE_COPY}
              </p>
              <button
                type="button"
                onClick={onUnshare}
                className={`mt-2 ${btnSecondary}`}
              >
                {confirmUnshare ? "Confirm unshare" : "Unshare from public"}
              </button>
            </>
          ) : (
            <>
              <p className="text-xs text-ink-muted">
                Share to public publishes this item onto the public graph. A
                see-grant is not this. {UNSHARE_COPY}
              </p>
              <button
                type="button"
                onClick={onShare}
                className={`mt-2 ${btnSecondary}`}
              >
                {confirmShare ? "Confirm share" : "Share to public"}
              </button>
            </>
          )}
        </div>
        <PostSeeGrantControls address={sessionAddress} item={item} />
      </div>
    );
  }

  if (item.permalink) {
    return (
      <a
        href={item.permalink}
        target="_blank"
        rel="noopener noreferrer"
        className={`${className} hover:border-signal`}
      >
        {inner}
      </a>
    );
  }
  return <div className={className}>{inner}</div>;
}
