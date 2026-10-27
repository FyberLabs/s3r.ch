import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import type { ChatMessage } from "./chat";
import type { FeedItem } from "./feed-types";
import { applySeeGrant, cancelSee, checkSee, roomSoul } from "./identity/check";
import { createMemorySeeAcl, emptySeeAclSnapshot } from "./identity/see-acl";
import { canShowRows, sourceAccess, sourceStatus, statusLabel } from "./views-access";
import { windowRows } from "./views-decorators";
import { formatCanonical, formatS3rchNetwork, type SourceRef } from "./views-source-ref";
import {
  DEPLOYMENT_KEY_FINGERPRINT,
  DEPLOYMENT_SELF_NETWORK,
  browseSources,
  createSubscriptionSet,
  dropPublicRoom,
  feedSourceOf,
  observeSource,
  readFeedItems,
  readForumCatalog,
  recheckView,
  resolveLoadedAccess,
  roomOwnershipToRegister,
  rowsForChat,
  rowsForFeed,
  rowsForForum,
  sourceStaysLive,
  syncViewSubscriptions,
  unsharedChatKeys,
} from "./views-live";
import { labelFor } from "./views-picker";
import { buildBrowseTree } from "./views-picker";
import type { View } from "./views-window";

const ME = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ORG = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const LAB = `s3rch:https://lab.fyberlabs.com:443;key=${"b".repeat(64)}`;
const NOW = 1_700_000_000;

const chat = (source: string, owner = ME, network = DEPLOYMENT_SELF_NETWORK): SourceRef => ({
  network,
  owner,
  source,
  kind: "chat",
  v: 1,
});

function viewWith(refs: SourceRef[], pending?: string[]): View {
  return {
    id: "v",
    title: "t",
    windows: refs.map((ref, index) => ({
      id: `w${index}`,
      kind: ref.kind,
      sources: [ref],
      mode: "single" as const,
      ...(pending && index === 0 ? { pending } : {}),
    })),
    layout: null,
    v: 1,
  };
}

function item(partial: Pick<FeedItem, "id" | "source" | "author" | "provenance"> & { ts?: number }): FeedItem {
  return {
    id: partial.id,
    source: partial.source,
    kind: "social",
    author: partial.author,
    body: partial.id,
    ts: partial.ts ?? 1,
    permalink: "",
    tags: [],
    provenance: partial.provenance,
  };
}

describe("deployment network", () => {
  it("is formatS3rchNetwork of this host and the agreed fingerprint", () => {
    assert.equal(createHash("sha256").update("s3r.ch deployment").digest("hex"), DEPLOYMENT_KEY_FINGERPRINT);
    assert.deepEqual(formatS3rchNetwork("s3r.ch", 443, DEPLOYMENT_KEY_FINGERPRINT), {
      ok: true,
      value: DEPLOYMENT_SELF_NETWORK,
    });
  });
});

describe("subscriptions", () => {
  it("starts and stops as the View changes, and retries a start that was not ready", () => {
    const log: string[] = [];
    let chatReady = false;
    const set = createSubscriptionSet((ref) => {
      if (ref.kind === "chat" && !chatReady) return null;
      log.push(`start ${ref.source}`);
      return () => log.push(`stop ${ref.source}`);
    });
    const room = chat("build");
    const forum: SourceRef = { ...room, source: "general", kind: "forum" };
    syncViewSubscriptions(set, viewWith([room]));
    assert.deepEqual(set.active(), []);
    chatReady = true;
    syncViewSubscriptions(set, viewWith([room, forum, room]));
    assert.deepEqual(log, ["start build", "start general"]);
    assert.equal(set.active().length, 2);
    syncViewSubscriptions(set, viewWith([forum]));
    assert.deepEqual(log, ["start build", "start general", "stop build"]);
    set.stopAll();
    assert.deepEqual(set.active(), []);
    assert.deepEqual(log, ["start build", "start general", "stop build", "stop general"]);
  });
});

describe("first-seen rows", () => {
  it("keeps the first observation across refetches and bounds each source", () => {
    const ref = chat("r1");
    const message = (id: string, ts: number): ChatMessage => ({ id, room: "r1", author: ME, body: id, ts, v: 1 });
    let rows = observeSource([], rowsForChat(ref, [message("m1", 10)]), 100);
    rows = observeSource(rows, rowsForChat(ref, [message("m1", 10), message("m2", 20), message("other", 30)]), 200);
    assert.equal(rows.find((row) => row.row.id === "m1")?.observedAt, 100);
    assert.equal(rows.find((row) => row.row.id === "m2")?.observedAt, 200);
    assert.equal(rowsForChat(ref, [{ id: "m1", room: "nope", author: ME, body: "x", ts: 1 }]).length, 0);
    assert.ok(rows.some((row) => row.row.key.endsWith("#m1")));

    const many = [1, 2, 3].map((n) => message(`m${n}`, n));
    let bounded = observeSource([], rowsForChat(ref, many), 10, 3);
    bounded = observeSource(bounded, rowsForChat(ref, many), 50, 2);
    assert.deepEqual(bounded.map((row) => row.row.id), ["m3", "m2"]);
    assert.ok(bounded.every((row) => row.observedAt === 10));

    const forum: SourceRef = { ...ref, source: "c1", kind: "forum" };
    const forumMessage = { id: "x", channel: "c1", owner: ME, bot: "bot", body: "b", ts: 1, v: 1 };
    let forumRows = observeSource([], rowsForForum(forum, [forumMessage]), 5);
    forumRows = observeSource(forumRows, rowsForForum(forum, [forumMessage]), 9);
    assert.equal(forumRows[0]?.observedAt, 5);
    assert.equal(forumRows[0]?.row.author, "bot");

    const rss = item({
      id: "post-1",
      source: "rss",
      author: "blog",
      provenance: "rss:https://blog.ethereum.org/en/feed.xml",
    });
    const again = { ...rss, id: "post-2", ts: 4 };
    const feed = feedSourceOf(rss, DEPLOYMENT_SELF_NETWORK);
    assert.ok(feed);
    let feedRows = observeSource([], rowsForFeed(feed.ref, [rss], DEPLOYMENT_SELF_NETWORK), 3);
    feedRows = observeSource(feedRows, rowsForFeed(feed.ref, [rss, again], DEPLOYMENT_SELF_NETWORK), 8);
    assert.equal(feedRows.find((row) => row.row.id === "post-1")?.observedAt, 3);
    assert.equal(feedRows.find((row) => row.row.id === "post-2")?.observedAt, 8);
    assert.equal(rowsForFeed(feed.ref, [item({ id: "fc", source: "farcaster", author: "dwr", provenance: "farcaster:hub:https://hub.pinata.cloud/v1/castsByFid?fid=3" })], DEPLOYMENT_SELF_NETWORK).length, 0);
  });
});

describe("access re-check", () => {
  it("clears a pending mark when a grant lands and shows Access removed when it is revoked", () => {
    const ref = chat("ops", ORG);
    const acl = createMemorySeeAcl();
    const ctx = (me: string | undefined = ME) => ({ me, selfNetwork: DEPLOYMENT_SELF_NETWORK, graph: acl, now: NOW });
    let current = viewWith([ref], [formatCanonical(ref)]);
    const stop = acl.subscribe(() => {
      current = recheckView(current, ctx()).view;
    });

    acl.putObject(roomSoul("ops"), ORG);
    assert.deepEqual(current.windows[0]?.pending, [formatCanonical(ref)]);
    assert.equal(sourceStatus(current.windows[0]!, ref, recheckView(current, ctx()).access(ref)), "waiting");

    applySeeGrant(acl, ORG, { claimId: "ops", accessor: ME, from: 0, until: NOW + 100 });
    const open = recheckView(current, ctx());
    assert.equal(open.view.windows[0]?.pending, undefined);
    assert.deepEqual(open.access(ref), { kind: "read", post: false });
    assert.equal(sourceStatus(open.view.windows[0]!, ref, open.access(ref)), "ready");

    const signedOut = recheckView(current, { ...ctx(), me: undefined });
    assert.equal(signedOut.access(ref).kind, "signin");
    assert.equal(statusLabel("signin"), "Sign in required");

    cancelSee(acl, ORG, ME, roomSoul("ops"));
    const revoked = recheckView(current, ctx());
    assert.equal(sourceStatus(revoked.view.windows[0]!, ref, revoked.access(ref)), "removed");
    assert.equal(statusLabel("removed"), "Access removed");
    stop();
    const frozen = current;
    acl.putObject("s3rch/rooms/other", ORG);
    assert.equal(current, frozen);
  });

  it("leaves another network as Needs connection", () => {
    const ref = chat("bench", ME, LAB);
    const acl = createMemorySeeAcl();
    acl.putObject(roomSoul("bench"), ME);
    const checked = recheckView(viewWith([ref], [formatCanonical(ref)]), {
      me: ME,
      selfNetwork: DEPLOYMENT_SELF_NETWORK,
      graph: acl,
      now: NOW,
    });
    assert.equal(checked.access(ref).kind, "needs-connection");
    assert.deepEqual(checked.view.windows[0]?.pending, [formatCanonical(ref)]);
    assert.equal(statusLabel(sourceStatus(checked.view.windows[0]!, ref, checked.access(ref))), "Needs connection");
  });
});

describe("browse catalog", () => {
  it("builds picker sources from rooms, forum channels and followed feeds", () => {
    const forum = readForumCatalog({
      channel: { id: "c1", owner: ME, created: 1, v: 1 },
      messages: [{ id: "m", channel: "c1", owner: ME, bot: "bot", body: "hi", ts: 4, v: 1 }],
      shared: [{ channel: { id: "c2", owner: ORG }, messages: [], desktop: null }],
    });
    assert.ok(forum);
    assert.equal(readForumCatalog({ denied: true }), null);

    const feedUrl = new URL("https://public.api.bsky.app/xrpc/app.bsky.feed.getFeed");
    feedUrl.searchParams.set("feed", "at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot");
    const authorUrl = new URL("https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed");
    authorUrl.searchParams.set("actor", "ethereum.bsky.social");
    const authorPost = "at://did:plc:ewvi7nxzyoun6zhxrhs64oiz/app.bsky.feed.post/abc";

    const items = readFeedItems({
      items: [
        item({ id: "e1", source: "rss", author: "week", provenance: "rss:https://blog.ethereum.org/en/feed.xml" }),
        item({ id: "e1b", source: "atom", author: "gh", provenance: "atom:https://github.com/farcasterxyz/protocol/commits/main.atom" }),
        item({ id: "cast", source: "farcaster", author: "dwr", provenance: "farcaster:hub:https://hub.pinata.cloud/v1/castsByFid?fid=3&pageSize=20&reverse=true" }),
        item({
          id: "note",
          source: "nostr",
          author: "ab".repeat(32),
          provenance: `nostr:relay:wss://nos.lol?kinds=1&authors=${"ab".repeat(32)}`,
        }),
        item({ id: "ap", source: "activitypub", author: "w3c", provenance: "activitypub:https://w3c.social/users/w3c/outbox" }),
        item({ id: authorPost, source: "atproto", author: "ethereum.bsky.social", provenance: `atproto:${feedUrl}` }),
        item({ id: authorPost, source: "atproto", author: "ethereum.bsky.social", provenance: `atproto:${authorUrl}` }),
        item({ id: "native", source: "s3rch", author: ME, provenance: `s3rch:native:${ME}` }),
        item({ id: "gi", source: "rss3", author: "gi", provenance: "rss3:gi:public" }),
      ],
    });

    const hot = feedSourceOf(items.find((row) => row.provenance.startsWith("atproto:") && row.provenance.includes("getFeed"))!, DEPLOYMENT_SELF_NETWORK);
    assert.equal(hot?.ref.owner, "did:plc:z72i7hdynmk6r22z27h6tvur");
    assert.equal(hot?.label, "whats-hot");
    const posts = feedSourceOf(items.find((row) => row.provenance.includes("getAuthorFeed"))!, DEPLOYMENT_SELF_NETWORK);
    assert.equal(posts?.ref.owner, "did:plc:ewvi7nxzyoun6zhxrhs64oiz");
    assert.equal(posts?.ref.source, "posts");
    assert.equal(feedSourceOf(item({ id: "nope", source: "atproto", author: "ethereum.bsky.social", provenance: `atproto:${authorUrl}` }), DEPLOYMENT_SELF_NETWORK), null);

    const sources = browseSources({
      selfNetwork: DEPLOYMENT_SELF_NETWORK,
      rooms: [{ id: "build", owner: ME, title: "ops" }],
      channels: forum.channels,
      items,
    });
    const room = sources.find((source) => source.ref.kind === "chat");
    const ownForum = sources.find((source) => source.ref.kind === "forum" && source.ref.source === "c1");
    const rss = sources.find((source) => source.ref.network === "rss" && source.ref.source.endsWith("/feed.xml"));
    assert.equal(room && labelFor(room.ref, sources), "# ops");
    assert.equal(ownForum?.label, "Forum · 0xf3…66");
    assert.equal(rss?.label, "blog.ethereum.org");
    assert.equal(rss?.ref.owner, "https://blog.ethereum.org");
    assert.ok(sources.some((source) => source.ref.network === "farcaster" && source.ref.owner === "3" && source.label === "dwr"));
    assert.ok(sources.some((source) => source.ref.network === "activitypub" && source.ref.owner === "https://w3c.social/users/w3c"));
    assert.ok(sources.some((source) => source.ref.kind === "feed" && source.ref.owner === ME && source.ref.network === DEPLOYMENT_SELF_NETWORK));
    assert.equal(sources.some((source) => source.ref.network === "rss3"), false);
    assert.equal(sources.filter((source) => source.ref.kind === "forum").length, 2);

    const tree = buildBrowseTree(sources, DEPLOYMENT_SELF_NETWORK, ME);
    assert.equal(tree[0]?.id, "self");
    assert.equal(tree[0]?.label, "This network (s3r.ch)");
    assert.ok(tree.some((node) => node.id === "protocols"));
  });
});

describe("loaded native access", () => {
  it("shows rows for a server-authorized forum and a loaded native feed", () => {
    const acl = createMemorySeeAcl();
    const ctx = { me: ME, selfNetwork: DEPLOYMENT_SELF_NETWORK, graph: acl, now: NOW };
    const shared: SourceRef = { network: DEPLOYMENT_SELF_NETWORK, owner: ORG, source: "c2", kind: "forum", v: 1 };
    assert.equal(sourceAccess(shared, ctx).kind, "on-open");
    const withheld = resolveLoadedAccess(shared, ctx, { channels: [], items: [] });
    assert.equal(withheld.kind, "on-open");
    assert.equal(canShowRows(withheld), false);

    const opened = resolveLoadedAccess(shared, ctx, { channels: [{ id: "c2", owner: ORG }], items: [] });
    assert.deepEqual(opened, { kind: "read", post: false });
    assert.equal(canShowRows(opened), true);
    const forumMessage = { id: "m", channel: "c2", owner: ORG, bot: "bot", body: "hi", ts: 4, v: 1 };
    const forumRows = observeSource([], rowsForForum(shared, [forumMessage]), 1);
    const forumWindow = viewWith([shared]).windows[0]!;
    assert.equal(windowRows(forumWindow, forumRows, () => opened).length, 1);
    assert.equal(windowRows(forumWindow, forumRows, () => withheld).length, 0);

    const own: SourceRef = { ...shared, owner: ME, source: "c1" };
    assert.deepEqual(resolveLoadedAccess(own, ctx, { channels: [], items: [] }), { kind: "read", post: true });

    const nativeItem = item({ id: "n", source: "s3rch", author: ME, provenance: `s3rch:native:${ME}` });
    const native = feedSourceOf(nativeItem, DEPLOYMENT_SELF_NETWORK);
    assert.ok(native);
    assert.equal(sourceAccess(native.ref, ctx).kind, "on-open");
    assert.equal(resolveLoadedAccess(native.ref, ctx, { channels: [], items: [] }).kind, "on-open");
    const feedRead = resolveLoadedAccess(native.ref, ctx, { channels: [], items: [nativeItem] });
    assert.deepEqual(feedRead, { kind: "read", post: false });
    const feedRows = observeSource([], rowsForFeed(native.ref, [nativeItem], DEPLOYMENT_SELF_NETWORK), 2);
    assert.equal(windowRows(viewWith([native.ref]).windows[0]!, feedRows, () => feedRead).length, 1);
    assert.equal(resolveLoadedAccess({ ...native.ref, network: LAB }, ctx, { channels: [], items: [nativeItem] }).kind, "needs-connection");
  });
});

describe("owned room registration", () => {
  it("registers a missing owned room after the graph loads and does not replace one already named", () => {
    const acl = createMemorySeeAcl();
    const rooms = [
      { id: "build", owner: ME, title: "ops" },
      { id: "ops", owner: ORG, title: "org" },
    ];
    const mine = chat("build", ME);
    const ctx = { me: ME, selfNetwork: DEPLOYMENT_SELF_NETWORK, graph: acl, now: NOW };
    assert.deepEqual(sourceAccess(mine, ctx), { kind: "locked", reason: "missing-object" });

    const early = roomOwnershipToRegister(rooms, ME, acl);
    assert.deepEqual(early, [{ object: roomSoul("build"), owner: ME }]);
    for (const row of early) acl.putObject(row.object, row.owner);
    acl.replace(emptySeeAclSnapshot());
    assert.equal(acl.hasObject(roomSoul("build")), false);
    assert.equal(checkSee(acl, roomSoul("build"), ME, NOW).reason, "missing-object");

    for (const row of roomOwnershipToRegister(rooms, ME, acl)) acl.putObject(row.object, row.owner);
    assert.deepEqual(sourceAccess(mine, ctx), { kind: "read", post: true });
    assert.equal(acl.hasObject(roomSoul("ops")), false);
    assert.deepEqual(roomOwnershipToRegister(rooms, ME, acl), []);

    const held = createMemorySeeAcl();
    held.putObject(roomSoul("build"), ORG);
    assert.deepEqual(roomOwnershipToRegister(rooms, ME, held), []);
    assert.equal(held.ownerOf(roomSoul("build")), ORG);
  });
});

describe("unpublished room chat", () => {
  it("stops public chat and clears its rows when the room is unpublished", () => {
    const log: string[] = [];
    const set = createSubscriptionSet((ref) => {
      log.push(`start ${ref.source}`);
      return () => log.push(`stop ${ref.source}`);
    });
    const room = chat("build", ME);
    const other = chat("ops", ORG);
    const publicIds = new Set(["build", "ops"]);
    const live = (ref: SourceRef) => sourceStaysLive(ref, publicIds);
    set.sync([room, other], live);
    assert.deepEqual(log, ["start build", "start ops"]);

    const message = (id: string, roomId: string): ChatMessage => ({ id, room: roomId, author: ME, body: id, ts: 1, v: 1 });
    const books = new Map<string, ReturnType<typeof observeSource>>([
      [formatCanonical(room), observeSource([], rowsForChat(room, [message("m", "build")]), 1)],
      [formatCanonical(other), observeSource([], rowsForChat(other, [message("n", "ops")]), 1)],
    ]);
    const nextIds = dropPublicRoom(publicIds, "build");
    for (const id of [...publicIds]) if (!nextIds.has(id)) publicIds.delete(id);
    const keys = unsharedChatKeys([room, other], "build");
    assert.deepEqual(keys, [formatCanonical(room)]);
    set.halt(keys);
    for (const key of keys) books.delete(key);
    set.sync([room, other], (ref) => sourceStaysLive(ref, publicIds));

    assert.deepEqual(log, ["start build", "start ops", "stop build"]);
    assert.deepEqual(set.active(), [formatCanonical(other)]);
    assert.equal(books.has(formatCanonical(room)), false);
    assert.equal(books.get(formatCanonical(other))?.length, 1);
    assert.equal(sourceStaysLive(room, publicIds), false);
    assert.equal(sourceStaysLive(other, publicIds), true);

    publicIds.add("build");
    set.sync([room, other], (ref) => sourceStaysLive(ref, publicIds));
    assert.deepEqual(log.at(-1), "start build");
    assert.deepEqual(unsharedChatKeys([chat("a.b")], "a_b"), [formatCanonical(chat("a.b"))]);
  });
});
