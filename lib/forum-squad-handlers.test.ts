import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import * as squad from "./forum-squad";
import * as check from "./identity/check";
import * as fixture from "./forum-squad-fixture";
import { signatureOf } from "./forum-sign";
import { soulKeyMatches } from "./unshare";
import { createForumReceiveProofs } from "./forum-receive-proofs";
import { createForumReceiveRetry } from "./forum-receive-retry";
import { createMemorySeeAcl } from "./identity/see-acl";
import { toGunNode, type FeedItem } from "./feed-types";

// Execute the actual component receive functions without mounting the disabled
// public fixture or reimplementing their admission/continuation logic. Only
// React state, transport and the cryptographic boundary are controlled here.
function handlers(names: string[], bindings: Record<string, unknown>) {
  const source = readFileSync(new URL("../components/SquadForum.tsx", import.meta.url), "utf8");
  const found = names.map(name => {
    const declaration = source.match(new RegExp(`^      (?:async )?function ${name}\\([\\s\\S]*?^      }`, "m"));
    assert.ok(declaration, name);
    return declaration[0];
  });
  const body = stripTypeScriptTypes(found.join("\n"));
  const env = { ...squad, ...check, ...fixture, signatureOf, soulKeyMatches, ...bindings };
  return new Function(...Object.keys(env), `${body}\nreturn { ${names.join(",")} };`)(...Object.values(env));
}
const flush = async () => { for (let n = 0; n < 4; n++) await new Promise<void>(resolve => setImmediate(resolve)); };
const envelope = (row: object, key: string) => ({ ...row, sig: "SEA" + JSON.stringify([row, key]) });
function proofSetup() {
  const keys = new Map(fixture.PILOT_AGENTS.map(a => [a.status.seaPubkey, a.status.seaPubkey]));
  keys.set(fixture.PILOT_OWNER, fixture.PILOT_OWNER);
  const proofs = createForumReceiveProofs({ key: p => keys.get(p) ?? null, ready: () => true,
    verify: async (sig, key) => { const [row, signedKey] = JSON.parse(sig.slice(3)); return signedKey === key ? row : null; } });
  return { keys, proofs };
}

test("actual chat retry installs the removal listener and consumes an existing signed tail", async () => {
  const h = proofSetup(), owner = fixture.PILOT_OWNER;
  const item = squad.buildForumStatement({ forumId: fixture.PILOT_FORUM_ID, author: owner, body: "retracted", now: 1762000100, entropy: "ab".repeat(16) })!;
  const node = toGunNode(item), tail = envelope({ id: item.id, forumId: fixture.PILOT_FORUM_ID, unshared: 1 }, owner);
  h.keys.delete(owner);
  const retries = createForumReceiveRetry(), watches = new Map(), offs = new Map();
  let rows: FeedItem[] = [], subscriptions = 0; const tombs = new Map<string, number>();
  const graph = createMemorySeeAcl(); graph.putObject(fixture.PILOT_FORUM_ID, owner);
  const nodeAt = (path: string[] = []): object => ({ get: (key: string) => nodeAt([...path, key]), on: (callback: (data: unknown) => void) => {
    assert.deepEqual(path, ["s3rch", "items", item.id, "remove"]); subscriptions++;
    callback(tail); return { off() {} };
  } });
  const graphRef = { current: graph };
  const accept = handlers(["acceptChat", "watchChatRemoval", "chatTombStamp"], {
    cancelled: false, proofs: h.proofs, retries, versions: squad.createMeshEventVersions(), graphRef,
    authority: { graph: { checkDirectSee: () => ({ allowed: true }), checkPost: () => ({ allowed: true }) } },
    chatRowsRef: { get current() { return rows; } }, chatTombsRef: { current: tombs },
    chatRemovalWatches: watches, chatRemovalOffs: offs, gun: nodeAt(), expireChatRemovalWatches: () => {},
    setMeshChat: (update: (prev: FeedItem[]) => FeedItem[]) => { rows = update(rows); }, setLocalChat: () => {},
    knownChatIds: () => rows.map(row => row.id),
    hideChat: (ids: string[]) => { for (const id of ids) tombs.set(id, Date.now()); rows = squad.withoutChatIds(rows, ids); },
    stickSigned: () => {},
  }).acceptChat;
  assert.equal(await accept(envelope(node, owner), item.id), false);
  assert.equal(subscriptions, 0); assert.equal(rows.length, 0);
  h.keys.set(owner, owner); retries.retry(); await flush();
  assert.equal(subscriptions, 1); assert.equal(rows.length, 0); assert.ok(tombs.has(item.id));
  assert.equal(await accept(envelope(node, owner), item.id), false); assert.equal(subscriptions, 1);
});

for (const fromCancel of [false, true]) test(`actual offer ${fromCancel ? "tail" : "main"} cancellation waits for rotated parent and preserves accepted-offer veto`, async () => {
  const h = proofSetup(), owner = fixture.PILOT_OWNER;
  const base = fixture.PILOT_NEEDS.find(n => n.stated === 1)!;
  const helper = fixture.PILOT_AGENTS.find(a => a.status.seaPubkey !== owner && a.status.seaPubkey !== base.subject)!.status.seaPubkey;
  const offer = { id: `offer_${check.seaToPrincipalKey(helper)}_${"ef".repeat(16)}`, need: base.id, forumId: fixture.PILOT_FORUM_ID, helper, body: "help", artifacts: "", stated: 0 as const };
  const closed = { ...base, stated: 0 as const, acceptedOffer: offer.id, hamState: base.hamState + 1 };
  async function retainParent(row: check.ForumNeed) {
    const scope = h.proofs.begin(); await scope.read(envelope(row, h.keys.get(owner)!).sig, owner); assert.ok(scope.retain(row));
  }
  await retainParent(closed);
  const graph = createMemorySeeAcl(); graph.putObject(base.id, owner);
  const needsRef = { current: new Map([[base.id, closed as check.ForumNeed]]) };
  const pending = new Map(), cancels = new Set<string>(), offers = new Map();
  const versions = squad.createMeshEventVersions(), retries = createForumReceiveRetry();
  const accept = handlers(["acceptOffer"], {
    cancelled: false, proofs: h.proofs, retries, versions, graphRef: { current: graph }, needsRef,
    pendingNeedsRef: { current: new Map() }, pendingOffersRef: { current: pending },
    removedOffersRef: { current: new Set() }, offerCancelsRef: { current: cancels },
    noteOfferCancel: (need: string, id: string) => cancels.add(squad.forumOfferCacheKey(need, id)),
    setMeshOffers: (update: (prev: Map<string, check.ForumOffer>) => Map<string, check.ForumOffer>) => {
      const next = update(offers); offers.clear(); for (const [key, row] of next) offers.set(key, row);
    }, setLocalOffers: () => {}, watchOfferTails: () => {},
  }).acceptOffer;
  h.keys.set(owner, "rotated-owner-key"); assert.equal(h.proofs.valid(closed), false);
  const scope = fromCancel ? "offer-cancel" : "offer";
  const gen = versions.bump(scope, `${base.id}:${offer.id}`);
  assert.equal(await accept(envelope(offer, helper), offer.id, base.id, gen, fromCancel), false);
  assert.equal(cancels.size, 0); assert.equal(offers.size, 0); assert.equal(pending.size, 1);
  await retainParent(closed); retries.retry(); await flush();
  assert.equal(cancels.size, 0); assert.equal(offers.size, 0); assert.equal(pending.size, 0);
  // A fresh, owner-authenticated reopen permits helper withdrawal again.
  const open = { ...base, hamState: closed.hamState + 1 }; await retainParent(open); needsRef.current.set(base.id, open);
  const next = versions.bump(scope, `${base.id}:${offer.id}`);
  assert.equal(await accept(envelope(offer, helper), offer.id, base.id, next, fromCancel), true);
  assert.equal(cancels.size, 1); assert.equal(offers.size, 1);
});
