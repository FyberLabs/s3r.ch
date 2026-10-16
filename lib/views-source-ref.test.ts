import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatCanonical,
  formatS3rchNetwork,
  formatShareable,
  parseCanonical,
  parseShareable,
  pct,
  sameSource,
  validateSourceRef,
  type SourceRef,
} from "./views-source-ref";

const KEY = "a".repeat(64);
const NET = `s3rch:https://s3r.ch:443;key=${KEY}`;
const ALICE = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

function room(source = "room/1:x"): SourceRef {
  return { network: NET, owner: ALICE, source, kind: "chat", v: 1 };
}

describe("SourceRef validation", () => {
  it("accepts an s3r.ch room and each open protocol owner form", () => {
    assert.equal(validateSourceRef(room()).ok, true);
    const ok: [string, string][] = [
      ["atproto", "did:plc:ewvi7nxzyoun6zhxrhs64oiz"],
      ["farcaster", "3"],
      ["farcaster", "18446744073709551615"],
      ["atproto", "did:web:example.com"],
      ["atproto", "did:web:example.com%3a8443"],
      ["atproto", "did:web:example.com%3A8443:users:alice"],
      ["nostr", "b".repeat(64)],
      ["activitypub", "https://social.example/users/a"],
      ["rss", "https://blog.example"],
    ];
    for (const [network, owner] of ok) {
      assert.equal(validateSourceRef({ network, owner, source: "f", kind: "feed", v: 1 }).ok, true, network);
    }
  });

  it("rejects handles, lowercase wallets, IP hosts and unknown fields", () => {
    const bad: unknown[] = [
      { ...room(), owner: ALICE.toLowerCase() },
      { network: "atproto", owner: "alice.bsky.social", source: "f", kind: "feed", v: 1 },
      { network: "nostr", owner: "npub1xyz", source: "f", kind: "feed", v: 1 },
      { network: "rss", owner: "https://blog.example/feed.xml", source: "f", kind: "feed", v: 1 },
      { ...room(), network: `s3rch:https://10.0.0.1:443;key=${KEY}` },
      { ...room(), network: `s3rch:https://localhost:443;key=${KEY}` },
      { ...room(), network: `s3rch:http://s3r.ch:80;key=${KEY}` },
      { ...room(), network: `s3rch:https://s3r.ch:0443;key=${KEY}` },
      { ...room(), network: "s3rch:https://s3r.ch:443" },
      { ...room(), network: `s3rch:https://0x7f.0x0.0x0.0x1:443;key=${KEY}` },
      { ...room(), network: `s3rch:https://127.1:443;key=${KEY}` },
      { ...room(), network: `s3rch:https://printer.local:443;key=${KEY}` },
      { ...room(), network: `s3rch:https://router.home.arpa:443;key=${KEY}` },
      { network: "atproto", owner: "did:web:printer.local", source: "f", kind: "feed", v: 1 },
      { network: "farcaster", owner: "18446744073709551616", source: "f", kind: "feed", v: 1 },
      { network: "farcaster", owner: "0", source: "f", kind: "feed", v: 1 },
      { network: "atproto", owner: "did:web:..", source: "f", kind: "feed", v: 1 },
      { network: "atproto", owner: "did:web:example.com::x", source: "f", kind: "feed", v: 1 },
      { ...room(), source: JSON.parse('"\\ud800"') as string },
      { ...room(), source: JSON.parse('"a\\udc00"') as string },
      { ...room(), extra: 1 },
      { ...room(), v: 2 },
      { ...room(), kind: "video" },
      { ...room(), source: "" },
      { network: "atproto", owner: "did:plc:ewvi7nxzyoun6zhxrhs64oiz", source: "f", kind: "feed", bindingHash: KEY, v: 1 },
      { ...room(), rootBindingHash: KEY },
      { ...room(), rootBindingHash: KEY, rootCounter: -1 },
      { ...room(), bindingHash: KEY.toUpperCase() },
    ];
    for (const b of bad) assert.equal(validateSourceRef(b).ok, false, JSON.stringify(b));
  });

  it("formats s3r.ch network ids and rejects bad ports", () => {
    assert.deepEqual(formatS3rchNetwork("s3r.ch", 443, KEY), { ok: true, value: NET });
    assert.equal(formatS3rchNetwork("s3r.ch", 70000, KEY).ok, false);
  });
});

describe("SourceRef strings", () => {
  it("percent-encodes everything outside unreserved", () => {
    assert.equal(pct("a/b:c!*'()~"), "a%2Fb%3Ac%21%2A%27%28%29~");
  });

  it("round-trips the canonical form and escapes separators inside components", () => {
    const ref = room("a/b?c#d é");
    const text = formatCanonical(ref);
    assert.equal(text.split("/").length, 4);
    assert.deepEqual(parseCanonical(text), { ok: true, value: ref });
  });

  it("rejects non-canonical, empty and extra components", () => {
    const text = formatCanonical(room("ab"));
    assert.equal(parseCanonical(text.replace("/ab/", "/%61b/")).ok, false);
    assert.equal(parseCanonical(text.replace("/ab/", "//")).ok, false);
    assert.equal(parseCanonical(`${text}/x`).ok, false);
    assert.equal(parseCanonical(text.replace("sr1:", "sr2:")).ok, false);
    assert.equal(parseCanonical(text.replace("/ab/", "/%zz/")).ok, false);
  });

  it("round-trips binding hints in the shareable form", () => {
    const ref: SourceRef = { ...room(), bindingHash: "1".repeat(64), rootBindingHash: "2".repeat(64), rootCounter: 3 };
    const text = formatShareable(ref);
    assert.ok(text.endsWith(`?b=${"1".repeat(64)}&r=${"2".repeat(64)}&rc=3`));
    assert.deepEqual(parseShareable(text), { ok: true, value: ref });
    assert.deepEqual(parseShareable(formatCanonical(ref)), { ok: true, value: room() });
  });

  it("rejects malformed hints", () => {
    const base = formatCanonical(room());
    for (const q of ["?x=1", `?b=${KEY}&b=${KEY}`, `?r=${KEY}`, `?rc=1&r=${KEY}`, `?r=${KEY}&rc=01`, "?b"]) {
      assert.equal(parseShareable(base + q).ok, false, q);
    }
  });

  it("compares identity without binding hints", () => {
    assert.equal(sameSource(room(), { ...room(), bindingHash: KEY }), true);
    assert.equal(sameSource(room(), room("other")), false);
  });
});
