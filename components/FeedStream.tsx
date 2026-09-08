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
  emptyNetworkCopy,
  itemsForTab,
} from "@/lib/feed-tabs";
import { ownsNativePost, prepareShareIntoMesh } from "@/lib/compose";
import { encodeKey } from "@/lib/identity/check";
import {
  fromGunRoomNode,
  itemsInRoom,
  mergeRooms,
  ownsRoom,
  prepareShareRoomIntoMesh,
  rankRooms,
  roomsForTab,
  type Room,
} from "@/lib/rooms";
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
import { ComposeForm } from "@/components/ComposeForm";
import { DiscoverPanel } from "@/components/DiscoverPanel";
import { IngestForm } from "@/components/IngestForm";
import { PostSeeGrantControls } from "@/components/PostSeeGrantControls";
import { RoomSeeGrantControls } from "@/components/RoomSeeGrantControls";
import { RoomChat } from "@/components/RoomChat";
import { RoomPresence } from "@/components/RoomPresence";
import { RoomsList } from "@/components/RoomsList";
import { TagChips } from "@/components/TagChips";
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
  const gunRef = useRef<GunRef | null>(null);
  const [seed, setSeed] = useState<FeedItem[]>([]);
  const [overlay, setOverlay] = useState<FeedItem[]>([]);
  const [meshItems, setMeshItems] = useState<FeedItem[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [tab, setTab] = useState<FeedTab>("public");
  const [meta, setMeta] = useState<Omit<FeedSnapshot, "items"> | null>(null);
  const [status, setStatus] = useState(TRYING_SEED_COPY);
  const [sharedIds, setSharedIds] = useState<string[]>([]);
  const [confirmShareId, setConfirmShareId] = useState<string | null>(null);
  const [shareMessage, setShareMessage] = useState<string | null>(null);
  const [mineRooms, setMineRooms] = useState<Room[]>([]);
  const [publicRooms, setPublicRooms] = useState<Room[]>([]);
  const [meshRooms, setMeshRooms] = useState<Room[]>([]);
  const [openRoomId, setOpenRoomId] = useState<string | null>(null);
  const [sharedRoomIds, setSharedRoomIds] = useState<string[]>([]);
  const [confirmShareRoomId, setConfirmShareRoomId] = useState<string | null>(
    null,
  );
  const [roomShareMessage, setRoomShareMessage] = useState<string | null>(null);
  const [overlayChat, setOverlayChat] = useState<ChatMessage[]>([]);
  const [graphChat, setGraphChat] = useState<ChatMessage[]>([]);
  const [overlayPresence, setOverlayPresence] = useState<PresenceEntry[]>([]);
  const [graphPresence, setGraphPresence] = useState<PresenceEntry[]>([]);
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

      const listener = gun.get("s3rch").get("items").map().on((data) => {
        const item = fromGunNode(
          data as Parameters<typeof fromGunNode>[0],
        );
        if (!item || cancelled) return;
        setSeed((prev) => mergeItems(prev, [item]));
        heardItemsRef.current = mergeItems(heardItemsRef.current, [item]);
        if (acceptLiveMeshWrite(seedWsUpRef.current)) {
          setMeshItems(heardItemsRef.current);
        }
      });
      off = typeof listener?.off === "function" ? () => listener.off?.() : undefined;

      const roomsListener = gun.get("s3rch").get("rooms").map().on((data) => {
        const room = fromGunRoomNode(
          data as Parameters<typeof fromGunRoomNode>[0],
        );
        if (!room || cancelled) return;
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
    setSelected(readDiscoverTagQuery());
  }, []);

  const tabRooms = useMemo(
    () => roomsForTab(tab, publicRooms, mineRooms, meshRooms),
    [tab, publicRooms, mineRooms, meshRooms],
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
    () => itemsForTab(tab, seed, overlay, meshItems),
    [tab, seed, overlay, meshItems],
  );
  const hasMeshRows = meshItems.length > 0 || meshRooms.length > 0;
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

  const seeRef = useRef(see);
  seeRef.current = see;
  const sessionRef = useRef(session);
  sessionRef.current = session;
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
    setOpenRoomId(null);
    setRoomShareMessage(null);
    setConfirmShareRoomId(null);
  }

  function applyDiscoverTags(next: string[]) {
    setSelected(next);
    writeDiscoverTagQuery(next);
    setOpenRoomId(null);
    setRoomShareMessage(null);
    setConfirmShareRoomId(null);
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
    setShareMessage("Published to the public graph. One-way here.");
    await see.persist();
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
      "Published this room node to the public graph. Posts inside stay Mine until you share those posts. One-way here.",
    );
    await see.persist();
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

      {tab !== "network" && !composeRoomId ? (
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
      </div>
      {tab === "network" ? (
        <p className="mt-2 text-xs text-ink-muted">
          Live mesh via the seed peer and WebRTC when ICE works. STUN is
          not TURN. This is not a finished P2P mesh. Meetings and streams
          are later. Mine overlay and ingest stay off this tab.
        </p>
      ) : null}

      {tab !== "mine" ? (
        <DiscoverPanel>
          tags={discovery.tags}
          rooms={discovery.rooms}
          selected={selected}
          selectedRoomId={openRoomId}
          onChange={applyDiscoverTags}
          onOpenRoom={(room) => {
            setOpenRoomId((current) => (current === room.id ? null : room.id));
            setRoomShareMessage(null);
            setConfirmShareRoomId(null);
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
            : undefined
        }
        showOwner={tab === "public" || tab === "network"}
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
          owned={ownsRoom(openRoom, session?.address)}
          shared={publishedRooms.has(openRoom.id)}
          confirmShare={confirmShareRoomId === openRoom.id}
          shareMessage={roomShareMessage}
          sessionAddress={session?.address ?? null}
          onClose={() => {
            setOpenRoomId(null);
            setRoomShareMessage(null);
            setConfirmShareRoomId(null);
          }}
          onShare={() => void shareRoomToPublic(openRoom)}
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

      {tab === "mine" ? (
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
          )}
        </p>
      ) : (
        <ul className="mt-8 space-y-3">
          {visible.map((item) => (
            <li key={item.id}>
              <FeedCard
                item={item}
                mine={tab === "mine"}
                sessionAddress={session?.address ?? null}
                shared={published.has(item.id)}
                confirmShare={confirmShareId === item.id}
                onShare={() => void shareToPublic(item)}
              />
            </li>
          ))}
        </ul>
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
): string {
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
  owned,
  shared,
  confirmShare,
  shareMessage,
  sessionAddress,
  onClose,
  onShare,
}: {
  room: Room;
  mine: boolean;
  network: boolean;
  owned: boolean;
  shared: boolean;
  confirmShare: boolean;
  shareMessage: string | null;
  sessionAddress: string | null;
  onClose: () => void;
  onShare: () => void;
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
        {network
          ? " Network is the live mesh view via the seed peer / WebRTC — not the snapshot."
          : " Trying seed peer; snapshot if the socket is down. Snapshot is not a chat log or a presence list."}
      </p>
      {mine && owned && sessionAddress ? (
        <div className="mt-3 border-t border-rule pt-3">
          {shared ? (
            <p className="text-xs text-ink-muted">
              This room node is on the public graph. Posts inside stay Mine
              until you share those posts. Publish is one-way here.
            </p>
          ) : (
            <>
              <p className="text-xs text-ink-muted">
                Share to public publishes this room node onto the public rooms
                graph. It does not publish Mine posts inside it. A see-grant is
                not this. Publish is one-way here.
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
          <RoomSeeGrantControls address={sessionAddress} roomId={room.id} />
        </div>
      ) : null}
    </div>
  );
}

function FeedCard({
  item,
  mine,
  sessionAddress,
  shared,
  confirmShare,
  onShare,
}: {
  item: FeedItem;
  mine: boolean;
  sessionAddress: string | null;
  shared: boolean;
  confirmShare: boolean;
  onShare: () => void;
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
            <p className="text-xs text-ink-muted">
              On the public graph. Publish is one-way here.
            </p>
          ) : (
            <>
              <p className="text-xs text-ink-muted">
                Share to public publishes this item onto the public graph. A
                see-grant is not this. Publish is one-way here.
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
        <PostSeeGrantControls address={sessionAddress} itemId={item.id} />
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
