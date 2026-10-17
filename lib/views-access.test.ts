import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { roomSoul, type SeeGraph } from "./identity/check";
import { accessLabel, addsAsPending, canPick, settlePending, sourceAccess, sourceStatus, statusLabel, type AccessContext } from "./views-access";
import { applyPick, type PickerSource } from "./views-picker";
import { formatCanonical, type SourceKind, type SourceRef } from "./views-source-ref";
import { validateWindow, type View, type ViewWindow } from "./views-window";

const ME = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ORG = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const NET = `s3rch:https://s3r.ch:443;key=${"a".repeat(64)}`;
const LAB = `s3rch:https://lab.fyberlabs.com:443;key=${"b".repeat(64)}`;

const ref = (source: string, owner = ME, kind: SourceKind = "chat", network = NET): SourceRef => ({ network, owner, source, kind, v: 1 });

function graph(rooms: Record<string, string>, grants: { room: string; accessor: string; from: number; until: number }[] = []): SeeGraph {
  return {
    hasObject: (o) => Object.keys(rooms).some((r) => roomSoul(r) === o),
    ownerOf: (o) => Object.entries(rooms).find(([r]) => roomSoul(r) === o)?.[1],
    seeGrants: (o) => grants.filter((g) => roomSoul(g.room) === o).map((g) => ({ claimId: g.room, accessor: g.accessor, from: g.from, until: g.until })),
  };
}

const ctx = (g: SeeGraph, me: string | undefined = ME): AccessContext => ({ me, selfNetwork: NET, graph: g, now: 100 });

describe("sourceAccess", () => {
  const g = graph({ build: ME, ops: ORG, finance: ORG }, [{ room: "ops", accessor: ME, from: 0, until: 1000 }]);

  it("uses Check for native rooms", () => {
    assert.deepEqual(sourceAccess(ref("build"), ctx(g)), { kind: "read", post: true });
    assert.deepEqual(sourceAccess(ref("ops", ORG), ctx(g)), { kind: "read", post: false });
    assert.equal(sourceAccess(ref("finance", ORG), ctx(g)).kind, "locked");
    assert.equal(accessLabel(sourceAccess(ref("ops", ORG), ctx(g))), "✓ read");
    assert.equal(accessLabel(sourceAccess(ref("build"), ctx(g))), "✓ read · ✓ post");
  });

  it("locks expired grants", () => {
    const old = graph({ ops: ORG }, [{ room: "ops", accessor: ME, from: 0, until: 50 }]);
    assert.deepEqual(sourceAccess(ref("ops", ORG), ctx(old)), { kind: "locked", reason: "expired" });
  });

  it("needs sign-in, and marks other networks and protocols", () => {
    assert.equal(sourceAccess(ref("build"), { ...ctx(g), me: undefined }).kind, "signin");
    assert.equal(sourceAccess(ref("lab", ME, "chat", LAB), ctx(g)).kind, "needs-connection");
    assert.equal(sourceAccess({ network: "farcaster", owner: "3", source: "dev", kind: "feed", v: 1 }, ctx(g)).kind, "read-only-unlinked");
    assert.equal(sourceAccess({ network: "rss", owner: "https://hn.example", source: "https://hn.example/rss", kind: "feed", v: 1 }, ctx(g)).kind, "read-only");
    assert.equal(sourceAccess(ref("general", ORG, "forum"), ctx(g)).kind, "on-open");
    assert.deepEqual(sourceAccess(ref("general", ME, "forum"), ctx(g)), { kind: "read", post: true });
  });

  it("decides what can be picked and what adds as pending", () => {
    assert.equal(canPick({ kind: "signin" }), false);
    assert.equal(canPick({ kind: "needs-connection" }), false);
    assert.equal(canPick({ kind: "locked", reason: "missing-grant" }), true);
    assert.equal(addsAsPending({ kind: "locked", reason: "missing-grant" }), true);
    assert.equal(addsAsPending({ kind: "read", post: false }), false);
  });
});

describe("window status", () => {
  const finance = ref("finance", ORG);
  const locked = { kind: "locked" as const, reason: "missing-grant" };
  const w: ViewWindow = { id: "w", kind: "chat", mode: "single", sources: [finance], pending: [formatCanonical(finance)] };

  it("shows waiting, declined and removed", () => {
    assert.equal(statusLabel(sourceStatus(w, finance, locked)), "Waiting for access");
    assert.equal(statusLabel(sourceStatus(w, finance, locked, true)), "Request declined");
    assert.equal(statusLabel(sourceStatus({ ...w, pending: undefined }, finance, locked)), "Access removed");
    assert.equal(sourceStatus(w, finance, { kind: "read", post: false }), "ready");
  });

  it("clears pending once access arrives, so a later revoke shows removed", () => {
    assert.equal(settlePending(w, () => locked), w);
    const settled = settlePending(w, () => ({ kind: "read", post: false }));
    assert.equal(settled.pending, undefined);
    assert.equal(sourceStatus(settled, finance, locked), "removed");
  });

  it("validates pending against the window's sources", () => {
    assert.ok(validateWindow(w).ok);
    assert.equal(validateWindow({ ...w, pending: [formatCanonical(ref("other"))] }).ok, false);
    assert.equal(validateWindow({ ...w, pending: [formatCanonical(finance), formatCanonical(finance)] }).ok, false);
    assert.equal(validateWindow({ ...w, pending: "x" }).ok, false);
  });
});

describe("pick as pending", () => {
  it("marks locked sources pending in new and existing windows", () => {
    const view: View = { id: "v", title: "t", windows: [], layout: null, v: 1 };
    const finance: PickerSource = { ref: ref("finance", ORG), label: "#finance" };
    const build: PickerSource = { ref: ref("build"), label: "#build" };
    const pending = (r: SourceRef) => r.source === "finance";
    let n = 0;
    const r = applyPick(view, { type: "new" }, [build, finance], { newId: () => `w${++n}`, pending });
    assert.ok(r.ok);
    assert.deepEqual(r.view.windows.map((w) => w.pending), [undefined, [formatCanonical(finance.ref)]]);
    const r2 = applyPick(r.view, { type: "window", windowId: r.windowIds[0]! }, [finance], { newId: () => `w${++n}`, pending });
    assert.ok(r2.ok);
    assert.deepEqual(r2.view.windows[0]!.pending, [formatCanonical(finance.ref)]);
    assert.equal(r2.view.windows[0]!.mode, "tabs");
  });
});
