import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parseIngestRequest } from "./browser-pull";
import { GUN_PROTOCOL_V } from "./feed-types";
import {
  PULL_RELAY_ALLOWED_HOSTS,
  PULL_RELAY_CHANNEL,
  PULL_RELAY_FARCASTER_HUB,
  PULL_RELAY_NOSTR_RELAY,
  PULL_RELAY_PROTOCOL_V,
  acceptPullRelayItems,
  assemblePullRelayFetches,
  canUsePullRelay,
  executePullRelay,
  followActivityPub,
  followActivityPubFirstPage,
  isPullRelayAllowedHost,
  isPullRelayAllowedUrl,
  isPullRelayPageOrigin,
  listPullRelaySeedUrls,
  materializePullRelayResult,
  parsePullRelayMessage,
  pullRelayDenied,
  pullRelayHello,
  pullRelayPull,
  pullRelayReady,
  seedUrlsForClass,
} from "./pull-relay";

const CAST_FIXTURE = {
  messages: [
    {
      hash: "0x532064659e980a9a4c3614f2b1deb3ac63e8cc9a",
      data: {
        type: "MESSAGE_TYPE_CAST_ADD",
        fid: 2,
        timestamp: 156796112,
        castAddBody: { text: "hub cast" },
      },
    },
  ],
};

describe("pull-relay allowlist", () => {
  it("is the documented source family, not an open proxy", () => {
    assert.deepEqual([...PULL_RELAY_ALLOWED_HOSTS], [
      "hub.pinata.cloud",
      "public.api.bsky.app",
      "blog.ethereum.org",
      "github.com",
      "w3c.social",
      "fosstodon.org",
      "nos.lol",
      "gi.rss3.io",
    ]);
    assert.equal(isPullRelayAllowedHost("hub.pinata.cloud"), true);
    assert.equal(isPullRelayAllowedUrl("https://hub.pinata.cloud/v1/castsByFid?fid=2"), true);
    assert.equal(isPullRelayAllowedUrl("wss://nos.lol"), true);
    assert.equal(isPullRelayAllowedUrl("https://blog.ethereum.org/en/feed.xml"), true);
    assert.equal(isPullRelayAllowedUrl("https://evil.example/feed.xml"), false);
    assert.equal(isPullRelayAllowedUrl("https://hub.pinata.cloud:8443/v1/info"), false);
    assert.equal(isPullRelayAllowedUrl("http://127.0.0.1:17373/s3rch-pull/hello"), false);
    assert.equal(isPullRelayAllowedUrl("https://user:pass@hub.pinata.cloud/"), false);
    assert.equal(isPullRelayAllowedUrl("file:///etc/passwd"), false);
    assert.equal(isPullRelayAllowedHost("localhost"), false);
    assert.equal(isPullRelayAllowedHost("metadata.google.internal"), false);
  });

  it("lists documented seed URLs and refuses unknown classes via parse", () => {
    const farcaster = parseIngestRequest({ allowedSource: "farcaster" });
    assert.equal(farcaster.kind, "allowedSource");
    if (farcaster.kind !== "allowedSource") return;
    const urls = listPullRelaySeedUrls(farcaster);
    assert.ok(urls.every((url) => url.startsWith(PULL_RELAY_FARCASTER_HUB)));
    assert.ok(urls.every(isPullRelayAllowedUrl));
    assert.equal(seedUrlsForClass("nostr")[0], PULL_RELAY_NOSTR_RELAY);
    assert.equal(canUsePullRelay({ allowedSource: "farcaster" }), true);
    assert.equal(canUsePullRelay({ rssUrl: "https://evil.example/feed.xml" }), false);
    assert.equal(canUsePullRelay({ rssUrl: "https://blog.ethereum.org/en/feed.xml" }), true);
    assert.equal(canUsePullRelay({ allowedSource: "neynar" }), false);
  });
});

describe("pull-relay handshake", () => {
  it("accepts v:1 hello / ready / pull and fails closed on unknown v", () => {
    assert.deepEqual(parsePullRelayMessage(pullRelayHello()), {
      kind: "hello",
      message: pullRelayHello(),
    });
    assert.deepEqual(parsePullRelayMessage(pullRelayReady("extension")), {
      kind: "ready",
      message: pullRelayReady("extension"),
    });
    const pull = pullRelayPull("abc", { allowedSource: "farcaster" });
    assert.equal(parsePullRelayMessage(pull).kind, "pull");
    assert.equal(
      parsePullRelayMessage({
        channel: PULL_RELAY_CHANNEL,
        type: "hello",
        v: 2,
      }).kind,
      "invalid",
    );
    assert.equal(
      parsePullRelayMessage({
        channel: PULL_RELAY_CHANNEL,
        type: "hello",
      }).kind,
      "invalid",
    );
    assert.equal(
      parsePullRelayMessage({
        channel: "other",
        type: "hello",
        v: PULL_RELAY_PROTOCOL_V,
      }).kind,
      "invalid",
    );
    assert.equal(
      parsePullRelayMessage({
        channel: PULL_RELAY_CHANNEL,
        type: "ready",
        v: PULL_RELAY_PROTOCOL_V,
        via: "chrome-store",
      }).kind,
      "invalid",
    );
    assert.equal(parsePullRelayMessage(pullRelayDenied("That host is not allowed.", "abc")).kind, "denied");
  });

  it("localhost page origin is http loopback only", () => {
    assert.equal(isPullRelayPageOrigin("http://localhost:3000"), true);
    assert.equal(isPullRelayPageOrigin("http://127.0.0.1:3000"), true);
    assert.equal(isPullRelayPageOrigin("https://s3r.ch"), false);
    assert.equal(isPullRelayPageOrigin("https://evil.example"), false);
  });
});

describe("pull-relay assemble + admit", () => {
  it("assembles a hub fixture and drops unknown Gun v", () => {
    const parsed = parseIngestRequest({ allowedSource: "farcaster" });
    assert.equal(parsed.kind, "allowedSource");
    if (parsed.kind !== "allowedSource") return;
    const url = `${PULL_RELAY_FARCASTER_HUB}/v1/castsByFid?fid=2&pageSize=20&reverse=true`;
    const pulled = assemblePullRelayFetches(parsed, [
      { url, status: 200, body: JSON.stringify(CAST_FIXTURE) },
      { url: "https://evil.example/casts", status: 200, body: JSON.stringify(CAST_FIXTURE) },
    ]);
    assert.equal(pulled.items.length, 1);
    assert.equal(pulled.items[0]?.source, "farcaster");
    assert.equal(pulled.items[0]?.v ?? GUN_PROTOCOL_V, GUN_PROTOCOL_V);
    assert.equal(pulled.sourcesOk, 1);

    const accepted = acceptPullRelayItems([
      pulled.items[0],
      { ...pulled.items[0], id: "0xdead", v: 2 },
      { id: "", source: "farcaster" },
    ]);
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]?.id, pulled.items[0]?.id);
  });

  it("executePullRelay denies arbitrary RSS and unknown sources", async () => {
    const denied = await executePullRelay(
      { rssUrl: "https://evil.example/feed.xml" },
      {
        fetchText: async () => {
          throw new Error("should not fetch");
        },
      },
    );
    assert.deepEqual(denied, { kind: "denied", error: "That host is not allowed." });

    const unknown = await executePullRelay(
      { allowedSource: "neynar" },
      { fetchText: async () => ({ url: "", status: 200, body: "" }) },
    );
    assert.equal(unknown.kind, "denied");
  });

  it("executePullRelay fetches allowlisted hub JSON through injected IO", async () => {
    const url = `${PULL_RELAY_FARCASTER_HUB}/v1/castsByFid?fid=2&pageSize=20&reverse=true`;
    const result = await executePullRelay(
      { allowedSource: "farcaster" },
      {
        fetchText: async (requested) => ({
          url: requested,
          status: requested.includes("fid=2") ? 200 : 200,
          body: requested.includes("fid=2")
            ? JSON.stringify(CAST_FIXTURE)
            : JSON.stringify({ messages: [] }),
        }),
      },
    );
    assert.equal(result.kind, "result");
    if (result.kind !== "result") return;
    assert.equal(result.items.length, 1);
    assert.ok(result.fetches.every((row) => isPullRelayAllowedUrl(row.url)));
    assert.ok(result.fetches.some((row) => row.url === url));
  });

  it("materialize prefers fetches and still fail-closes unknown v items", () => {
    const body = { allowedSource: "farcaster" };
    const url = `${PULL_RELAY_FARCASTER_HUB}/v1/castsByFid?fid=2`;
    const fromFetches = materializePullRelayResult(body, {
      channel: PULL_RELAY_CHANNEL,
      type: "result",
      v: 1,
      id: "1",
      fetches: [{ url, status: 200, body: JSON.stringify(CAST_FIXTURE) }],
    });
    assert.equal(fromFetches.items.length, 1);

    const fromItems = materializePullRelayResult(body, {
      channel: PULL_RELAY_CHANNEL,
      type: "result",
      v: 1,
      id: "2",
      items: [
        {
          id: "ok",
          source: "farcaster",
          kind: "social",
          author: "v",
          body: "x",
          ts: 1,
          permalink: "",
          tags: "farcaster",
          provenance: "farcaster:hub:fixture",
          v: 1,
        },
        {
          id: "future",
          source: "farcaster",
          kind: "social",
          author: "v",
          body: "x",
          ts: 1,
          permalink: "",
          tags: "farcaster",
          provenance: "farcaster:hub:fixture",
          v: 2,
        },
      ],
    });
    assert.equal(fromItems.items.length, 1);
    assert.equal(fromItems.items[0]?.id, "ok");
  });

  it("ActivityPub follow stays on the allowlist", () => {
    const actor = followActivityPub({
      url: "https://w3c.social/users/w3c",
      status: 200,
      body: JSON.stringify({
        outbox: "https://w3c.social/users/w3c/outbox",
      }),
    });
    assert.deepEqual(actor, ["https://w3c.social/users/w3c/outbox"]);
    assert.deepEqual(
      followActivityPub({
        url: "https://w3c.social/users/w3c",
        status: 200,
        body: JSON.stringify({ outbox: "https://evil.example/outbox" }),
      }),
      [],
    );
    assert.deepEqual(
      followActivityPubFirstPage({
        url: "https://w3c.social/users/w3c/outbox",
        status: 200,
        body: JSON.stringify({
          first: "https://w3c.social/users/w3c/outbox?page=1",
        }),
      }),
      ["https://w3c.social/users/w3c/outbox?page=1"],
    );
    assert.deepEqual(
      followActivityPubFirstPage({
        url: "https://w3c.social/users/w3c/outbox",
        status: 200,
        body: JSON.stringify({
          orderedItems: [{ type: "Note", id: "https://w3c.social/1" }],
          first: "https://w3c.social/users/w3c/outbox?page=1",
        }),
      }),
      [],
    );
  });
});

describe("extension scaffold stays allowlisted", () => {
  it("MV3 host_permissions match the documented fetch hosts", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../extensions/s3rch-pull/manifest.json", import.meta.url), "utf8"),
    ) as {
      manifest_version: number;
      host_permissions: string[];
    };
    assert.equal(manifest.manifest_version, 3);
    assert.ok(!manifest.host_permissions.includes("<all_urls>"));
    const hosts = new Set<string>();
    for (const perm of manifest.host_permissions) {
      const href = perm.replace(/\*$/, "");
      const url = new URL(href);
      assert.equal(isPullRelayAllowedHost(url.hostname), true);
      hosts.add(url.hostname);
    }
    assert.deepEqual([...hosts].sort(), [...PULL_RELAY_ALLOWED_HOSTS].sort());
  });
});
