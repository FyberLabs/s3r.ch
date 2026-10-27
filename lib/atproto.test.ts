import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { atprotoPermalink, atprotoProvenance, normalizeAtprotoPost } from "./atproto";
import { fromGunNode, toGunNode } from "./feed-types";

describe("normalizeAtprotoPost", () => {
  it("maps an AppView feed row into a tagged Gun item", () => {
    const item = normalizeAtprotoPost(
      {
        post: {
          uri: "at://did:plc:c7p4h77c22jsb4ooprjurpll/app.bsky.feed.post/3mtuif5duvk2o",
          author: { handle: "ethereum.bsky.social" },
          record: {
            text: "Inflation",
            createdAt: "2026-08-24T23:45:53.284Z",
          },
        },
      },
      "atproto:https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=ethereum.bsky.social",
    );
    assert.ok(item);
    assert.equal(item.source, "atproto");
    assert.equal(item.kind, "social");
    assert.equal(item.author, "ethereum.bsky.social");
    assert.equal(item.body, "Inflation");
    assert.equal(item.ts, Math.floor(Date.parse("2026-08-24T23:45:53.284Z") / 1000));
    assert.equal(
      item.permalink,
      "https://bsky.app/profile/ethereum.bsky.social/post/3mtuif5duvk2o",
    );
    assert.deepEqual(item.tags, ["atproto", "bsky", "social"]);
    assert.match(item.provenance, /^atproto:/);
  });

  it("skips rows without a post uri", () => {
    assert.equal(normalizeAtprotoPost({ post: { record: { text: "x" } } }, "atproto:test"), null);
    assert.equal(normalizeAtprotoPost({}, "atproto:test"), null);
  });

  it("survives a Gun round-trip", () => {
    const item = normalizeAtprotoPost(
      {
        post: {
          uri: "at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3mu3jzet72s2k",
          author: { handle: "bsky.app" },
          record: { text: "hello", createdAt: "2026-08-27T19:03:40.084Z" },
        },
      },
      "atproto:test",
    );
    assert.ok(item);
    assert.deepEqual(fromGunNode(toGunNode(item)), { ...item, v: 1 });
  });
});

describe("atprotoProvenance", () => {
  const actorDid = "did:plc:ewvi7nxzyoun6zhxrhs64oiz";
  const otherDid = "did:plc:abcdefghijklmnopqrstuvwx";
  const authorUrl = "https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=ethereum.bsky.social&limit=20";

  it("retains the requested actor DID for the actor's posts and reposts", () => {
    const provenance = atprotoProvenance(authorUrl, [
      {
        post: {
          uri: `at://${actorDid}/app.bsky.feed.post/own`,
          author: { did: actorDid, handle: "ethereum.bsky.social" },
        },
      },
      {
        post: {
          uri: `at://${otherDid}/app.bsky.feed.post/repost`,
          author: { did: otherDid, handle: "someone.bsky.social" },
        },
        reason: { by: { did: actorDid, handle: "ethereum.bsky.social" } },
      },
    ]);
    const url = new URL(provenance.slice("atproto:".length));
    assert.equal(url.searchParams.get("actor"), "ethereum.bsky.social");
    assert.equal(url.searchParams.get("actorDid"), actorDid);
  });

  it("does not take a repost URI as the feed actor", () => {
    const provenance = atprotoProvenance(authorUrl, [
      {
        post: {
          uri: `at://${otherDid}/app.bsky.feed.post/repost`,
          author: { did: otherDid, handle: "someone.bsky.social" },
        },
      },
    ]);
    assert.equal(new URL(provenance.slice("atproto:".length)).searchParams.get("actorDid"), null);
  });

  it("keeps a DID actor and drops a conflicting pair", () => {
    const didActor = `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(actorDid)}`;
    assert.equal(new URL(atprotoProvenance(didActor, []).slice("atproto:".length)).searchParams.get("actorDid"), actorDid);
    const conflict = atprotoProvenance(authorUrl, [
      { post: { author: { did: actorDid, handle: "ethereum.bsky.social" } } },
      { post: { author: { did: otherDid, handle: "ethereum.bsky.social" } } },
    ]);
    assert.equal(new URL(conflict.slice("atproto:".length)).searchParams.get("actorDid"), null);
    const generator = "https://public.api.bsky.app/xrpc/app.bsky.feed.getFeed?feed=at%3A%2F%2Fdid%3Aplc%3Az72i7hdynmk6r22z27h6tvur%2Fapp.bsky.feed.generator%2Fwhats-hot";
    assert.equal(atprotoProvenance(generator, []).includes("actorDid"), false);
  });
});

describe("atprotoPermalink", () => {
  it("builds a bsky.app profile URL from handle + rkey", () => {
    assert.equal(
      atprotoPermalink("ethereum.bsky.social", "at://did:plc:abc/app.bsky.feed.post/rkey1"),
      "https://bsky.app/profile/ethereum.bsky.social/post/rkey1",
    );
  });
});
