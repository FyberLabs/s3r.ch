import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AccessState } from "./views-access";
import type { ViewRow } from "./views-adapters";
import { canPostTo, checkSend, chooseTarget, composerTargets } from "./views-composer";
import { mergeFeedRows, originBadge, sourceColor, SOURCE_PALETTE, windowTitle } from "./views-decorators";
import { formatCanonical, type SourceKind, type SourceRef } from "./views-source-ref";
import { validateWindow, type ViewWindow } from "./views-window";

const ME = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const NET = `s3rch:https://s3r.ch:443;key=${"a".repeat(64)}`;
const ref = (source: string, kind: SourceKind = "chat"): SourceRef => ({ network: NET, owner: ME, source, kind, v: 1 });
const hn: SourceRef = { network: "rss", owner: "https://hn.example", source: "https://hn.example/rss", kind: "feed", v: 1 };
const dev: SourceRef = { network: "farcaster", owner: "3", source: "dev", kind: "feed", v: 1 };

function row(source: SourceRef, id: string, ts: number): ViewRow {
  return { key: `${formatCanonical(source)}#${id}`, source, id, author: "a", body: id, ts };
}

describe("decorators", () => {
  it("labels origins and windows", () => {
    assert.equal(originBadge(ref("build")), "s3r.ch › 0xf3…66");
    assert.equal(originBadge(dev), "Farcaster › 3");
    const w: ViewWindow = { id: "w", kind: "chat", mode: "tabs", sources: [ref("a"), ref("b")] };
    assert.equal(windowTitle(w, (r) => r.source), "chat · 2 sources");
    assert.equal(windowTitle({ ...w, label: "Ops" }, (r) => r.source), "Ops");
    assert.equal(windowTitle({ ...w, mode: "single", sources: [ref("a")] }, (r) => `#${r.source}`), "#a");
  });

  it("uses palette colors only and keeps sources in a window distinct", () => {
    const sources = Array.from({ length: 8 }, (_, i) => ref(`r${i}`));
    const w: ViewWindow = { id: "w", kind: "chat", mode: "tabs", sources };
    const colors = sources.map((s) => sourceColor(w, s));
    assert.equal(new Set(colors).size, 8);
    const chosen = { ...w, colorBy: { [formatCanonical(sources[0]!)]: "rose", [formatCanonical(sources[1]!)]: "red; background:url(x)" } };
    assert.equal(sourceColor(chosen, sources[0]!), "rose");
    assert.ok((SOURCE_PALETTE as readonly string[]).includes(sourceColor(chosen, sources[1]!)));
    assert.notEqual(sourceColor(chosen, sources[1]!), "rose");
  });
});

describe("merged feed", () => {
  it("clamps future timestamps to the observed time", () => {
    const rows = mergeFeedRows([
      { row: row(hn, "future", 10_000), observedAt: 100 },
      { row: row(dev, "recent", 150), observedAt: 200 },
      { row: row(hn, "old", 50), observedAt: 100 },
    ]);
    assert.deepEqual(rows.map((r) => r.id), ["recent", "future", "old"]);
  });

  it("breaks ties by observed time, then key, and drops duplicates", () => {
    const rows = mergeFeedRows([
      { row: row(hn, "b", 100), observedAt: 100 },
      { row: row(dev, "a", 100), observedAt: 300 },
      { row: row(hn, "b", 100), observedAt: 100 },
    ]);
    assert.deepEqual(rows.map((r) => r.id), ["a", "b"]);
  });

  it("rejects merged windows that are not feeds", () => {
    assert.equal(validateWindow({ id: "m", kind: "chat", mode: "merged", sources: [ref("a"), ref("b")] }).ok, false);
    assert.ok(validateWindow({ id: "m", kind: "feed", mode: "merged", sources: [hn, dev] }).ok);
  });
});

describe("composer", () => {
  const post: AccessState = { kind: "read", post: true };
  const read: AccessState = { kind: "read", post: false };
  const a = ref("a");
  const b = ref("b");
  const c = ref("c");
  const tabs: ViewWindow = { id: "t", kind: "chat", mode: "tabs", sources: [a, b, c] };
  const access = (r: SourceRef) => (r.source === "b" ? read : post);

  it("targets only postable sources and none in merged windows", () => {
    assert.equal(canPostTo({ kind: "read-only" }), false);
    assert.deepEqual(composerTargets(tabs, access).map((r) => r.source), ["a", "c"]);
    assert.deepEqual(composerTargets({ id: "m", kind: "feed", mode: "merged", sources: [hn, dev] }, () => post), []);
  });

  it("defaults to the replied message's source, then the last target", () => {
    const targets = composerTargets(tabs, access);
    assert.equal(chooseTarget(targets)?.source, "a");
    assert.equal(chooseTarget(targets, { last: c })?.source, "c");
    assert.equal(chooseTarget(targets, { last: b })?.source, "a");
    assert.equal(chooseTarget(targets, { replyTo: c, last: a })?.source, "c");
    assert.equal(chooseTarget(targets, { replyTo: b }), null);
  });

  it("sends one message to one postable source", () => {
    const targets = composerTargets(tabs, access);
    assert.deepEqual(checkSend(targets, c, "  hi "), { ok: true, target: c, text: "hi" });
    assert.equal(checkSend(targets, b, "hi").ok, false);
    assert.equal(checkSend(targets, null, "hi").ok, false);
    assert.equal(checkSend(targets, a, "   ").ok, false);
  });
});
