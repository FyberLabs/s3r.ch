import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { composeNativePost } from "./compose";
import {
  acceptLiveMeshWrite,
  emptyGrantedCopy,
  emptyNetworkCopy,
  GRANTED_NEEDS_PEER_COPY,
  itemsForTab,
  NETWORK_NEEDS_PEER_COPY,
} from "./feed-tabs";
import type { FeedItem } from "./feed-types";

const ALICE = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const NOW = 1_700_000_000;

function seedItem(): FeedItem {
  return {
    id: "rss3:act/1",
    source: "rss3",
    kind: "social",
    author: "lab",
    body: "seed snapshot row",
    ts: NOW,
    permalink: "https://example.test/seed",
    tags: ["social"],
    provenance: "rss3:gi:test",
  };
}

function ingestItem(): FeedItem {
  return {
    id: "rss:user/1",
    source: "rss",
    kind: "rss",
    author: "me",
    body: "overlay ingest",
    ts: NOW,
    permalink: "https://example.test/ingest",
    tags: ["rss", "user"],
    provenance: "rss:https://example.test/ingest.xml",
  };
}

describe("itemsForTab Public / Mine / Network", () => {
  it("Public is seed; Mine is overlay; Network is live mesh only", () => {
    const native = composeNativePost({
      body: "still mine",
      address: ALICE,
      nowSeconds: NOW,
      entropy: "aabbcc",
    });
    assert.ok(native);
    const seed = [seedItem()];
    const overlay = [native, ingestItem()];
    const mesh = [seedItem()];

    const pub = itemsForTab("public", seed, overlay, mesh);
    assert.equal(pub.some((row) => row.id === native.id), false);
    assert.equal(pub.some((row) => row.id === seed[0].id), true);
    assert.equal(pub.some((row) => row.id === ingestItem().id), false);

    const mine = itemsForTab("mine", seed, overlay, mesh);
    assert.equal(mine.some((row) => row.id === native.id), true);
    assert.equal(mine.some((row) => row.id === ingestItem().id), true);
    assert.equal(mine.some((row) => row.id === seed[0].id), false);

    const network = itemsForTab("network", seed, overlay, mesh);
    assert.deepEqual(
      network.map((row) => row.id),
      mesh.map((row) => row.id),
    );
    assert.equal(network.some((row) => row.id === native.id), false);
    assert.equal(network.some((row) => row.id === ingestItem().id), false);
  });

  it("Network ignores snapshot seed and Mine overlay when mesh is empty", () => {
    const native = composeNativePost({
      body: "unshared",
      address: ALICE,
      nowSeconds: NOW,
      entropy: "dead01",
    });
    assert.ok(native);
    const seed = [seedItem()];
    const overlay = [native, ingestItem()];
    assert.deepEqual(itemsForTab("network", seed, overlay), []);
    assert.deepEqual(itemsForTab("network", seed, overlay, []), []);
  });

  it("Network does not pick up unshared native after a Public share of a different item", () => {
    const native = composeNativePost({
      body: "keep mine",
      address: ALICE,
      nowSeconds: NOW,
      entropy: "cafe01",
    });
    assert.ok(native);
    const shared = { ...seedItem(), id: "s3rch:shared/1" };
    const seed = [seedItem(), shared];
    const overlay = [native];
    const mesh = [shared];
    assert.equal(itemsForTab("public", seed, overlay, mesh).some((row) => row.id === shared.id), true);
    assert.equal(itemsForTab("network", seed, overlay, mesh).some((row) => row.id === native.id), false);
    assert.equal(itemsForTab("network", seed, overlay, mesh)[0]?.id, shared.id);
  });

  it("Granted is the delivery inbox and does not leak into Public or Network", () => {
    const native = composeNativePost({
      body: "granted to me",
      address: ALICE,
      nowSeconds: NOW,
      entropy: "bb22",
    });
    assert.ok(native);
    const seed = [seedItem()];
    const overlay = [ingestItem()];
    const mesh = [seedItem()];
    const granted = [native];
    assert.equal(itemsForTab("granted", seed, overlay, mesh, granted)[0]?.id, native.id);
    assert.equal(itemsForTab("public", seed, overlay, mesh, granted).some((row) => row.id === native.id), false);
    assert.equal(itemsForTab("network", seed, overlay, mesh, granted).some((row) => row.id === native.id), false);
    assert.equal(itemsForTab("mine", seed, overlay, mesh, granted).some((row) => row.id === native.id), false);
  });
});

describe("acceptLiveMeshWrite", () => {
  it("writes mesh rows only while the seed peer is up", () => {
    assert.equal(acceptLiveMeshWrite(true), true);
    assert.equal(acceptLiveMeshWrite(false), false);
  });
});

describe("emptyNetworkCopy", () => {
  it("uses the honest down-peer line when the socket is down and memory is empty", () => {
    assert.equal(
      emptyNetworkCopy({
        tagged: false,
        inRoom: false,
        seedWsUp: false,
        hasMeshRows: false,
      }),
      NETWORK_NEEDS_PEER_COPY,
    );
    assert.equal(
      emptyNetworkCopy({
        tagged: true,
        inRoom: false,
        seedWsUp: false,
        hasMeshRows: false,
      }),
      NETWORK_NEEDS_PEER_COPY,
    );
  });

  it("keeps last-seen mesh empty copy after a brief hi, and room copy", () => {
    assert.equal(
      emptyNetworkCopy({
        tagged: false,
        inRoom: false,
        seedWsUp: false,
        hasMeshRows: true,
      }),
      "Nothing here yet.",
    );
    assert.equal(
      emptyNetworkCopy({
        tagged: true,
        inRoom: false,
        seedWsUp: true,
        hasMeshRows: true,
      }),
      "No posts for these tags.",
    );
    assert.equal(
      emptyNetworkCopy({
        tagged: false,
        inRoom: true,
        seedWsUp: true,
        hasMeshRows: true,
      }),
      "No posts in this room yet.",
    );
  });
});

describe("emptyGrantedCopy", () => {
  it("asks for SIWE when signed out and names the down-peer case", () => {
    assert.match(
      emptyGrantedCopy({
        signedIn: false,
        tagged: false,
        inRoom: false,
        seedWsUp: false,
        hasGrantedRows: false,
      }),
      /sign in/i,
    );
    assert.equal(
      emptyGrantedCopy({
        signedIn: true,
        tagged: false,
        inRoom: false,
        seedWsUp: false,
        hasGrantedRows: false,
      }),
      GRANTED_NEEDS_PEER_COPY,
    );
  });
});
