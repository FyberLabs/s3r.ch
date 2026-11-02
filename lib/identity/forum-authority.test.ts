import assert from "node:assert/strict";
import test from "node:test";
import { p256 } from "@noble/curves/nist.js";
import { createForumAuthority, type ForumAuthoritySnapshot } from "./forum-authority";
import { parseForumAuthority, type AuthorityKind } from "./forum-authority-records";
import { seaToPrincipalKey, type ForumNeed } from "./forum-check";
import { checkSee, checkForumSee, offerForumHelp, acceptForumOffer, declineForumOffer, continueForumOfferCancellation } from "./check";
import { publishForumAuthorized } from "../forum-authorized-publish";
import { createMemorySeeAcl } from "./see-acl";
import { readFileSync } from "node:fs";
import vectors from "./vectors/forum-authority.json";
import type { ForumWitnessKey } from "./forum-witness-verification";
const b64 = (x: Uint8Array | string) => Buffer.from(x).toString("base64url");
const secret = (n: number) => { const b = new Uint8Array(32); b[31] = n; return b; };
const pub = (n: number) => { const b = p256.getPublicKey(secret(n), false); return b64(b.slice(1, 33)) + "." + b64(b.slice(33)); };
const owner = pub(1), helper = pub(2), outsider = pub(3);
const id = (kind: string, n = 1, tail = "1") => `${kind}_${seaToPrincipalKey(pub(n))}_${tail.repeat(32)}`;
const object = id("need"), forum = id("forum"), setId = id("set");
const config = { keys: vectors.context.jwks.keys as ForumWitnessKey[], policy: vectors.context.policy, pinnedIssuers: vectors.context.pinnedIss };
const time = 1700000060;
const sign = (kind: AuthorityKind, row: Record<string, unknown>, key = 1): ForumAuthoritySnapshot["rows"][number] => {
  const r = { issuedAt: time - 10, ...row, sig: "pending" };
  const p = parseForumAuthority(kind, r); assert.ok(p);
  r.sig = b64(p256.sign(p.bytes, secret(key), { prehash: true, format: "compact" }));
  return { kind, soul: p.soul, record: r };
};
const owned = (target = object, key = 1) => sign("object", { object: target, owner: pub(key) }, key);
const direct = (kind: "see" | "post" = "see", stated = 1, hamState = 1) => sign(kind, { owner, object, accessor: helper, stated, hamState, from: time - 1, until: time + 100 });
const member = (role: "member" | "set", stated = 1, cancels: string[] = [], hamState = 1) => sign("membership", { role, predicate: "same-group", set: setId, member: helper, setOwner: owner, stated, hamState, cancels }, role === "member" ? 2 : 1);
const binding = (stated = 1, cancels: string[] = [], hamState = 1) => sign("object-set", { owner, object, predicate: "same-group", set: setId, stated, hamState, cancels });
const group = () => [owned(), member("member"), member("set"), binding()];
function cancel(kind: "membership" | "object-set", cancelId = "a".repeat(64), key = 1) {
  const ref = kind === "membership" ? member("member") : binding();
  return sign("cancel", { kind, rowSoul: ref.soul, cancelId, prior: [], signer: pub(key), predicate: "same-group", set: setId,
    member: helper, setOwner: owner, ...(kind === "object-set" ? { object } : {}) }, key);
}
const snapshot = (rows: ForumAuthoritySnapshot["rows"], at = time): ForumAuthoritySnapshot => ({ completeThrough: at,
  history: { completeThrough: at, links: [], accounts: [owner, helper, outsider].map(principal => ({ principal, rotations: [], revocations: [], genesisEpubBindings: [] })) }, rows });
const need: ForumNeed = { id: object, forumId: forum, subject: outsider, body: "need", stated: 1, severity: "need", ts: time, hamState: 1 };
const offerInput = { writer: helper, need, body: "help", now: time, entropy: "f".repeat(32) };

for (const c of vectors.cases) test(`upstream forum admission: ${c.name}`, async () => {
  type Step = { op: string; row?: unknown; record?: unknown; rotations?: string; object?: string; accessor?: string; allowed?: boolean; reason?: string };
  const a = createForumAuthority(config, () => time), rows: ForumAuthoritySnapshot["rows"][number][] = [];
  const rotations = new Map<string, unknown[]>();
  for (const step of c.steps as Step[]) {
    const kind = ({ put: "object", "admit-member": "membership", "admit-object-set": "object-set", "admit-cancel": "cancel", admit: "see" } as Record<string, AuthorityKind>)[step.op];
    if (kind) {
      const row = step.record ?? step.row, parsed = parseForumAuthority(kind, row); assert.ok(parsed, step.op);
      rows.push({ kind, soul: parsed.soul, record: row });
      if (step.rotations === "rotated") rotations.set(parsed.signer, vectors.context.rotationSets.rotated);
    } else if (step.op === "check-forum") {
      const input = snapshot(rows);
      const source = { ...input, history: { completeThrough: time, links: vectors.context.links.map(([, row]) => row),
        accounts: vectors.context.authenticatedAccounts.map(principal => ({ principal, rotations: rotations.get(principal) ?? [], revocations: [], genesisEpubBindings: [] })) } };
      assert.ok((await a.refresh(source, time)).ok);
      // Source fixtures use separate Check clocks. This graph binds admission
      // and Check to the same instant; compare allow/deny at that instant.
      assert.equal(checkForumSee(a.graph, step.object!, step.accessor!, time).allowed, step.allowed);
    }
  }
});

test("unsigned legacy persistence and sample owners cannot enter the authority graph", async () => {
  const legacy = createMemorySeeAcl(); legacy.putObject(object, owner); legacy.stateSeeGrant(owner, { claimId: object, accessor: helper, from: 0, until: time + 100 });
  const a = createForumAuthority(config, () => time);
  assert.equal((await a.refresh(legacy.snapshot() as unknown as ForumAuthoritySnapshot, time)).ok, false);
  assert.equal(a.graph.ownerOf(object), undefined);
  assert.equal("putObject" in a.graph, false);
  const s = snapshot([{ kind: "object", soul: object, record: { object, owner } }]);
  assert.ok((await a.refresh(s, time)).ok); assert.equal(a.graph.hasObject(object), false);
  assert.equal(legacy.ownerOf(object), owner); // No destructive legacy migration.
});

test("signed ownership is required and collisions/wrong transport souls deny", async () => {
  const a = createForumAuthority(config, () => time);
  assert.ok((await a.refresh(snapshot([direct()]), time)).ok); assert.equal(checkForumSee(a.graph, object, helper, time).allowed, false);
  const good = owned();
  for (const bad of [{ ...good, soul: id("need", 1, "2") }, { ...good, record: { ...(good.record as object), owner: outsider } }, { ...good, record: { ...(good.record as object), sig: "forged" } }]) {
    await a.refresh(snapshot([bad, direct()]), time); assert.equal(a.graph.hasObject(object), false);
  }
  await a.refresh(snapshot([direct(), good]), time); assert.equal(a.graph.ownerOf(object), owner);
  assert.equal(checkForumSee(a.graph, object, helper, time).allowed, true);
});

test("group admission needs both assents plus exact owner-signed binding", async () => {
  const a = createForumAuthority(config, () => time), rows = group();
  for (const missing of [0, 1, 2, 3]) {
    await a.refresh(snapshot(rows.filter((_, i) => i !== missing)), time);
    assert.equal(checkForumSee(a.graph, object, helper, time).allowed, false);
  }
  await a.refresh(snapshot(rows), time);
  assert.equal(checkForumSee(a.graph, object, helper, time).reason, "same-group");
  assert.equal(checkForumSee(a.graph, object, outsider, time).allowed, false);
  assert.equal(checkSee(a.graph, object, helper, time).allowed, false);
  assert.equal(a.graph.checkPost(object, helper, time).allowed, false);
});

test("direct, post and group cancellations remain independent", async () => {
  const a = createForumAuthority(config, () => time), rows = [...group(), direct(), direct("post")];
  await a.refresh(snapshot([...rows, direct("see", 0)]), time);
  assert.equal(checkForumSee(a.graph, object, helper, time).reason, "same-group");
  assert.equal(a.graph.checkPost(object, helper, time).allowed, true);
  await a.refresh(snapshot([...rows, cancel("membership")]), time);
  assert.equal(checkForumSee(a.graph, object, helper, time).reason, "see-grant");
  await a.refresh(snapshot([...rows, direct("see", 0), cancel("membership"), direct("post", 0)]), time);
  assert.equal(checkForumSee(a.graph, object, helper, time).allowed, false);
  assert.equal(a.graph.checkPost(object, helper, time).allowed, false);
});

test("cancel-before-join and high-HAM unobserved rejoin cannot erase cancellation", async () => {
  const a = createForumAuthority(config, () => time), revoked = cancel("membership", "a".repeat(64), 2);
  const rows = [revoked, ...group(), member("member", 1, [], 100), member("set", 1, [], 100)];
  await a.refresh(snapshot(rows), time); assert.equal(checkForumSee(a.graph, object, helper, time).allowed, false);
  await a.refresh(snapshot([...rows, member("member", 1, ["a".repeat(64)], 101), member("set", 1, ["a".repeat(64)], 101)]), time);
  assert.equal(checkForumSee(a.graph, object, helper, time).allowed, true);
  await a.refresh(snapshot([...group(), cancel("object-set")]), time); assert.equal(checkForumSee(a.graph, object, helper, time).allowed, false);
});

test("offer preparation and acceptance both use live group authority and never mint ownership", async () => {
  const a = createForumAuthority(config, () => time); await a.refresh(snapshot(group()), time);
  const offer = offerForumHelp({ ...offerInput, graph: a.graph }); assert.ok(offer.ok && offer.offer);
  assert.equal(a.graph.ownerOf(offer.offer.id), undefined);
  const input = { graph: a.graph, writer: owner, need, offer: offer.offer, postedOffers: new Map([[offer.offer.id, offer.offer]]), now: time };
  assert.ok(acceptForumOffer(input).ok);
  await a.refresh(snapshot([...group(), cancel("object-set")]), time);
  assert.equal(acceptForumOffer(input).ok, false); assert.equal(offerForumHelp({ ...offerInput, graph: a.graph }).ok, false);
});

test("expired clocks, missing/forked history and in-flight refreshes revoke old authority", async () => {
  let now = time;
  const a = createForumAuthority(config, () => now), s = snapshot(group()); await a.refresh(s, time);
  now++; assert.equal(checkForumSee(a.graph, object, helper, now).allowed, false); assert.equal(a.graph.ownerOf(object), undefined);
  now = time;
  const pending = a.refresh(s, time); assert.equal(checkForumSee(a.graph, object, helper, time).allowed, false);
  a.invalidate(); assert.equal((await pending).ok, false);
  const missing = { ...s, history: { ...s.history, accounts: [] } };
  assert.equal((await a.refresh(missing, time)).ok, false); assert.equal(a.graph.ownerOf(object), undefined);
  for (const t of [NaN, Infinity, -1, -0, time + .1]) assert.equal(checkForumSee(a.graph, object, helper, t).allowed, false);
});

test("snapshot mutation during verification and superseded refresh cannot install stale grants", async () => {
  const a = createForumAuthority(config, () => time), rows = group(), s = snapshot(rows);
  const pending = a.refresh(s, time); rows.length = 0;
  assert.ok((await pending).ok); assert.equal(checkForumSee(a.graph, object, helper, time).allowed, true);
  const first = a.refresh(snapshot(group()), time), second = a.refresh(snapshot([owned()]), time);
  await Promise.all([first, second]); assert.equal(checkForumSee(a.graph, object, helper, time).allowed, false);
});

test("Squad uses the isolated provider, not legacy ACL hydration or implicit chat admission", () => {
  const page = readFileSync("app/feed/squad/page.tsx", "utf8"), component = readFileSync("components/SquadForum.tsx", "utf8");
  assert.match(page, /ForumAuthorityProvider/); assert.doesNotMatch(page, /SeeAclProvider|MeshAclSync/);
  assert.doesNotMatch(component, /admitFeedNode|see\.acl|see\.persist|overlaySeeGraph/);
  assert.match(component, /PILOT_MESH_ENABLED \? authority\?\.graph \?\? null : sampleAcl/);
  assert.match(component, /publishForumAuthorized/);
});

import { recoveryId } from "./forum-recovery-records";
async function attest(row: ForumAuthoritySnapshot["rows"][number]) {
  const p = parseForumAuthority(row.kind, row.record)!;
  const [x, y] = pub(7).split(".");
  const key: ForumWitnessKey = { kid: "test-witness", kty: "EC", crv: "P-256", x, y, notBefore: 0, notAfter: time + 1000 };
  const input = b64(JSON.stringify({ alg: "ES256", kid: key.kid })) + "." + b64(JSON.stringify({ typ: "sociacl-acl-attest-v1", principal: p.signer,
    recordId: await recoveryId(p.bytes), iat: p.row.issuedAt, exp: p.row.issuedAt + 600 }));
  const token = input + "." + b64(p256.sign(new TextEncoder().encode(input), secret(7), { prehash: true, format: "compact" }));
  return { key, row: { ...row, record: { ...(row.record as object), attest: token } } };
}
const rotatedSnapshot = (rows: ForumAuthoritySnapshot["rows"]): ForumAuthoritySnapshot => ({ ...snapshot(rows), history: {
  completeThrough: time, links: vectors.context.links.map(([, r]) => r), accounts: [owner, helper].map(principal => ({ principal,
    rotations: principal === owner ? vectors.context.rotationSets.rotated : [], revocations: [], genesisEpubBindings: [] })),
} });
test("retired-key live grants are rejected while witnessed cancellation still constrains fresh rows", async () => {
  const oldCancel = sign("see", { owner, object, accessor: helper, stated: 0, hamState: 10, from: 0, until: time + 100, issuedAt: time - 40 });
  const witnessed = await attest(oldCancel);
  const a = createForumAuthority({ ...config, keys: [...config.keys, witnessed.key] }, () => time);
  const newObject = sign("object", { object, owner }, 2), newGrant = sign("see", { owner, object, accessor: helper, stated: 1, hamState: 9, from: 0, until: time + 100 }, 2);
  assert.ok((await a.refresh(rotatedSnapshot([newObject, newGrant]), time)).ok);
  assert.equal(checkForumSee(a.graph, object, helper, time).allowed, true);
  await a.refresh(rotatedSnapshot([newObject, newGrant, witnessed.row]), time);
  assert.equal(a.graph.ownerOf(object), owner); assert.equal(checkForumSee(a.graph, object, helper, time).allowed, false);
  await a.refresh(rotatedSnapshot([newObject, newGrant, oldCancel]), time);
  assert.equal(checkForumSee(a.graph, object, helper, time).allowed, true);
  const oldAllow = sign("see", { owner, object, accessor: helper, stated: 1, hamState: 20, from: 0, until: time + 100, issuedAt: time - 40 });
  const witnessedAllow = await attest(oldAllow);
  await a.refresh(rotatedSnapshot([newObject, witnessedAllow.row]), time);
  assert.equal(checkForumSee(a.graph, object, helper, time).allowed, false);
  await a.refresh(rotatedSnapshot([owned(), newGrant]), time);
  assert.equal(a.graph.ownerOf(object), undefined);
});

test("missing recovery evidence denies ownership and forged witness cannot preserve an old cancellation", async () => {
  const a = createForumAuthority(config, () => time);
  const input = rotatedSnapshot([sign("object", { object, owner }, 2)]);
  // A witnessed transition with missing authorizer evidence must not emit a key.
  const gap = vectors.context.rotationSets.rotated[0];
  const missing = { ...input, history: { ...input.history, accounts: input.history.accounts.map(a => a.principal === owner ? { ...a, rotations: [gap], revocations: [null] } : a), links: [] } };
  assert.equal((await a.refresh(missing, time)).ok, false);
  assert.equal(a.graph.ownerOf(object), undefined);
  const forged = sign("see", { owner, object, accessor: helper, stated: 0, hamState: 99, from: 0, until: time + 100, issuedAt: time - 40, attest: "forged" });
  const good = sign("see", { owner, object, accessor: helper, stated: 1, hamState: 1, from: 0, until: time + 100 }, 2);
  await a.refresh(rotatedSnapshot([sign("object", { object, owner }, 2), good, forged]), time);
  assert.equal(checkForumSee(a.graph, object, helper, time).allowed, true);
});

test("grant windows and cancellation tie-breaks are independent of arrival order", async () => {
  const a = createForumAuthority(config, () => time), allow = direct(), stop = direct("see", 0);
  for (const rows of [[owned(), allow, stop], [stop, owned(), allow]]) {
    await a.refresh(snapshot(rows), time); assert.equal(checkForumSee(a.graph, object, helper, time).allowed, false);
  }
  for (const window of [{ from: time + 1, until: time + 2 }, { from: time - 1, until: time }]) {
    const row = sign("see", { owner, object, accessor: helper, stated: 1, hamState: 1, ...window });
    await a.refresh(snapshot([owned(), row]), time); assert.equal(checkForumSee(a.graph, object, helper, time).allowed, false);
  }
});

test("getters, oversized lists and stale watermarks never establish authority", async () => {
  let reads = 0;
  const a = createForumAuthority(config, () => time);
  const r = Object.defineProperty({}, "kind", { get() { reads++; return "object"; } });
  await a.refresh(snapshot([r] as unknown as ForumAuthoritySnapshot["rows"]), time); assert.equal(a.graph.hasObject(object), false);
  assert.equal(reads, 0);
  assert.equal((await a.refresh(snapshot(Array(1025).fill(owned())), time)).ok, false);
  assert.equal((await a.refresh({ ...snapshot(group()), completeThrough: time - 1 }, time)).ok, false);
});

 test("direct Check cannot bypass exact-time binding through owner or grant shortcuts", async () => {
  const a = createForumAuthority(config, () => time); await a.refresh(snapshot([owned(), direct()]), time);
  assert.equal(checkSee(a.graph, object, owner, time).allowed, true);
  assert.equal(checkSee(a.graph, object, owner, time - 1).allowed, false);
  assert.equal(checkSee(a.graph, object, helper, time - 1).allowed, false);
});

test("complete cancellation history must include predecessors and cannot cycle", async () => {
  const a = createForumAuthority(config, () => time), first = cancel("membership");
  const linked = (id: string, prior: string[]) => sign("cancel", { ...(first.record as object), cancelId: id, prior });
  const second = linked("b".repeat(64), ["a".repeat(64)]);
  assert.equal((await a.refresh(snapshot([...group(), second]), time)).ok, false);
  assert.ok((await a.refresh(snapshot([second, ...group(), first]), time)).ok);
  assert.equal(checkForumSee(a.graph, object, helper, time).allowed, false);
  assert.equal((await a.refresh(snapshot([...group(), second, linked("a".repeat(64), ["b".repeat(64)])]), time)).ok, false);
});

import { offerSeeWait, authorizeForumOffer } from "../forum-squad";
test("receive paths defer offers until signed grants arrive, then recheck the same helper", async () => {
  const a = createForumAuthority(config, () => time); await a.refresh(snapshot(group()), time);
  const prepared = offerForumHelp({ ...offerInput, graph: a.graph }); assert.ok(prepared.ok && prepared.offer);
  const offer = prepared.offer;
  await a.refresh(snapshot([owned()]), time);
  assert.equal(offerSeeWait({ graph: a.graph, need, offer, now: time }), true);
  assert.equal(authorizeForumOffer(offer, helper, forum, { owner, subject: need.subject }, { graph: a.graph, need, now: time }), false);
  await a.refresh(snapshot(group()), time);
  assert.equal(offerSeeWait({ graph: a.graph, need, offer, now: time }), false);
  assert.equal(authorizeForumOffer(offer, helper, forum, { owner, subject: need.subject }, { graph: a.graph, need, now: time }), true);
  await a.refresh(snapshot([...group(), cancel("object-set")]), time);
  assert.equal(offerSeeWait({ graph: a.graph, need, offer, now: time }), false);
  assert.equal(authorizeForumOffer(offer, helper, forum, { owner, subject: need.subject }, { graph: a.graph, need, now: time }), false);
  a.invalidate(); assert.equal(offerSeeWait({ graph: a.graph, need, offer, now: time }), true);
});

const issued = (row: ForumAuthoritySnapshot["rows"][number], issuedAt: number) =>
  sign(row.kind, { ...(row.record as Record<string, unknown>), issuedAt },
    row.kind === "membership" && (row.record as { role: string }).role === "member" ? 2 : 1);

for (const [name, rows, futureIndex, check] of [
  ["object", [owned(), direct()], 0, "see"],
  ["see", [owned(), direct()], 1, "see"],
  ["post", [owned(), direct("post")], 1, "post"],
  ["member assent", group(), 1, "forum"],
  ["set assent", group(), 2, "forum"],
  ["object-set", group(), 3, "forum"],
] as const) test(`future-issued ${name} cannot authorize before its issuance boundary`, async () => {
  let now = time;
  const a = createForumAuthority(config, () => now);
  const records = rows.map((row, index) => index === futureIndex ? issued(row, time + 1) : row);
  const allowed = () => (check === "post" ? a.graph.checkPost(object, helper, now) :
    check === "see" ? checkSee(a.graph, object, helper, now) : checkForumSee(a.graph, object, helper, now)).allowed;
  const result = await a.refresh(snapshot(records, now), now);
  assert.ok(result.ok);
  assert.deepEqual(result.diagnostics, [{ index: futureIndex, reason: "future-record" }]);
  assert.equal(allowed(), false);
  now++;
  assert.ok((await a.refresh(snapshot(records, now), now)).ok);
  assert.equal(allowed(), true);
});

for (const row of [direct("see", 0, 2), direct("post", 0, 2), member("member", 0, [], 2),
  member("set", 0, [], 2), binding(0, [], 2), cancel("membership"), cancel("object-set")]) {
  test(`future-issued cancellation is inactive: ${row.kind} ${(row.record as { role?: string; kind?: string }).role ?? (row.record as { kind?: string }).kind ?? ""}`, async () => {
    let now = time;
    const a = createForumAuthority(config, () => now);
    const directKind = row.kind === "see" || row.kind === "post" ? row.kind : null;
    const rows = [...(directKind ? [owned(), direct(directKind)] : group()), issued(row, time + 1)];
    const allowed = () => (directKind === "post" ? a.graph.checkPost(object, helper, now) :
      checkForumSee(a.graph, object, helper, now)).allowed;
    const result = await a.refresh(snapshot(rows, now), now);
    assert.ok(result.ok);
    assert.equal(result.diagnostics.at(-1)?.reason, "future-record");
    assert.equal(allowed(), true);
    now++;
    assert.ok((await a.refresh(snapshot(rows, now), now)).ok);
    assert.equal(allowed(), false);
  });
}

test("cancellation tail survives its self-echo but rechecks current authority and parent state", async () => {
  const a = createForumAuthority(config, () => time);
  await a.refresh(snapshot([owned(), direct()]), time);
  const offered = offerForumHelp({ ...offerInput, graph: a.graph });
  assert.ok(offered.ok && offered.offer);
  const offer = offered.offer;
  const posted = new Map([[offer.id, offer]]);
  let parent = need;
  const input = () => ({ graph: a.graph, writer: owner, need: parent, offer, postedOffers: posted, now: time });
  const declined = declineForumOffer(input());
  assert.ok(declined.ok && declined.offer);
  const record = declined.offer;
  let puts = 0;
  assert.equal(await publishForumAuthorized({ record, authorized: () => declineForumOffer(input()).ok,
    sign: async () => "signature", put: () => { puts++; return true; } }), "signed");
  let finish!: (sig: string) => void;
  const tail = () => publishForumAuthorized({ record,
    authorized: () => continueForumOfferCancellation(input()).ok,
    sign: () => new Promise<string>(resolve => { finish = resolve; }),
    put: () => { puts++; return true; } });
  const pending = tail();
  posted.set(offer.id, record); // First put echoes while the tail is signing.
  assert.equal(declineForumOffer(input()).ok, false);
  finish("signature");
  assert.equal(await pending, "signed");
  assert.equal(puts, 2);
  for (const changed of [{ ...record, body: "different" }, { ...record, artifacts: object },
    { ...record, need: id("need", 1, "2") }]) {
    posted.set(offer.id, changed);
    assert.equal(continueForumOfferCancellation(input()).ok, false);
  }
  posted.set(offer.id, record);
  assert.equal(continueForumOfferCancellation({ ...input(), writer: helper }).ok, false);
  const closed = tail();
  parent = { ...need, stated: 0 };
  finish("signature");
  assert.equal(await closed, "denied");
  parent = need;
  const revoked = tail();
  a.invalidate();
  finish("signature");
  assert.equal(await revoked, "denied");
  assert.equal(puts, 2);
});
