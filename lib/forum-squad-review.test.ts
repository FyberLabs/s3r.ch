import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PILOT_AGENTS, PILOT_NEEDS, PILOT_OWNER, PILOT_FORUM_ID } from './forum-squad-fixture';
import { applySeeGrant, seaToPrincipalKey, type ForumOffer } from './identity/check';
import { createMemorySeeAcl } from './identity/see-acl';
import {
  forumOfferCacheKey, offersForNeed, offerBlockedByCancel, authorizeForumOffer,
  pendingClosureContext, needClosureStatus, authorizeForumNeed, needSignerCandidates,
  authorizeForumMeshRemoval, retainPendingStatus, prunePendingStatuses, cacheForumStatus,
  parseStatusHighWater, restoreForumStatusCache, STATUS_CACHE_CAP, PENDING_STATUS_TTL_MS, STATUS_WATCH_TTL_MS,
  grantStatusWatch, expireStatusWatches, statusWatchCandidate, createMeshEventVersions,
  type PendingStatus,
} from './forum-squad';

const need = PILOT_NEEDS.find(n => n.stated === 1 && n.subject !== PILOT_OWNER)!;
const helper = PILOT_AGENTS.find(a => a.status.seaPubkey !== need.subject && a.status.seaPubkey !== PILOT_OWNER)!.status.seaPubkey;
const offer = { id: `offer_${seaToPrincipalKey(helper)}_${'ef'.repeat(16)}`, need: need.id,
  forumId: PILOT_FORUM_ID, helper, body: 'help', artifacts: '', stated: 1 as const };
const closed = { ...need, stated: 0 as const, acceptedOffer: offer.id, hamState: need.hamState + 1 };

function graph() {
  const g = createMemorySeeAcl(); g.putObject(need.id, PILOT_OWNER);
  applySeeGrant(g, PILOT_OWNER, { claimId: need.id, accessor: helper, from: 0, until: 10_000_000_000 });
  return g;
}

test('fresh closed parent hydrates its offer without admitting the closure prematurely', () => {
  const g = graph(); const posted = new Map();
  assert.equal(authorizeForumNeed(closed, PILOT_OWNER, PILOT_OWNER, PILOT_FORUM_ID, undefined,
    { graph: g, postedOffers: posted, now: 1000 }), false);
  const context = pendingClosureContext(closed, PILOT_OWNER, PILOT_OWNER)!;
  assert.ok(context);
  assert.equal(authorizeForumOffer(offer, helper, PILOT_FORUM_ID, undefined, { graph: g, need: context, now: 1000 }), true);
  posted.set(forumOfferCacheKey(need.id, offer.id), offer);
  assert.equal(authorizeForumNeed(closed, PILOT_OWNER, PILOT_OWNER, PILOT_FORUM_ID, undefined,
    { graph: g, postedOffers: offersForNeed(posted, need.id), now: 1000 }), true);
  assert.equal(pendingClosureContext(closed, helper, PILOT_OWNER), undefined);
  assert.ok(pendingClosureContext(closed, need.subject, PILOT_OWNER, undefined, need));
  assert.equal(pendingClosureContext({ ...closed, subject: helper }, helper, PILOT_OWNER, undefined, need), undefined);
});

test('need removal verification includes the admitted subject without an unsigned hint', () => {
  const candidates = needSignerCandidates(PILOT_OWNER, need.subject);
  assert.ok(candidates.includes(need.subject));
  assert.equal(authorizeForumMeshRemoval({ removal: { removed: 1, action: 'remove', kind: 'need',
    forumId: PILOT_FORUM_ID, id: need.id }, mapKey: need.id, signer: need.subject,
    owner: PILOT_OWNER, subject: need.subject, forumId: PILOT_FORUM_ID }), true);
});

test('a second parent cannot cancel, remove or displace the first parent offer', () => {
  const other = PILOT_NEEDS.find(n => n.id !== need.id)!;
  const forged = { ...offer, need: other.id, stated: 0 as const };
  assert.equal(authorizeForumOffer(forged, other.subject, PILOT_FORUM_ID, { subject: other.subject }), true);
  const victimKey = forumOfferCacheKey(need.id, offer.id);
  const otherKey = forumOfferCacheKey(other.id, offer.id);
  const offers = new Map<string, ForumOffer>([[victimKey, offer], [otherKey, forged]]);
  const cancels = new Set([otherKey]);
  assert.equal(offerBlockedByCancel(cancels, offer), false);
  assert.equal(offersForNeed(offers, need.id).get(offer.id), offer);
  offers.delete(otherKey);
  assert.equal(offers.get(victimKey), offer);
  assert.equal(needClosureStatus(closed, { graph: graph(), postedOffers: offersForNeed(offers, need.id), now: 1000 }), 'ok');
});

test('pending admission keeps the newest signed status and expires without replay extension', () => {
  const status = PILOT_AGENTS[0].status;
  const queue = new Map<string, PendingStatus>();
  assert.equal(retainPendingStatus(queue, { ...status, state: 'emergency', lastUpdate: 20 }, 0), true);
  assert.equal(retainPendingStatus(queue, { ...status, state: 'idle', lastUpdate: 10 }, 1), false);
  assert.equal(queue.get(status.seaPubkey)!.status.state, 'emergency');
  retainPendingStatus(queue, { ...status, lastUpdate: 30 }, PENDING_STATUS_TTL_MS - 1);
  prunePendingStatuses(queue, PENDING_STATUS_TTL_MS);
  assert.equal(queue.size, 0);
});

test('stored admitted status rejects older and conflicting same-time replays after reload', () => {
  const status = PILOT_AGENTS[0].status;
  const cache = new Map();
  assert.equal(cacheForumStatus(cache, { ...status, state: 'idle', lastUpdate: 20 }), true);
  const restored = parseStatusHighWater(JSON.stringify([...cache.values()]), PILOT_FORUM_ID);
  assert.equal(cacheForumStatus(restored, { ...status, state: 'emergency', lastUpdate: 10 }), false);
  assert.equal(cacheForumStatus(restored, { ...status, state: 'emergency', lastUpdate: 20 }), false);
  assert.equal(restored.get(status.seaPubkey)!.state, 'idle');
  assert.equal(cacheForumStatus(restored, { ...status, state: 'idle', lastUpdate: 20 }), true);
});

test('agent watchers require authenticated keys and expire; pending status count is bounded', () => {
  const watches = new Map<string, number>(); const queue = new Map<string, PendingStatus>();
  assert.equal(statusWatchCandidate('attacker-path', { sig: 'SEA' }), false);
  assert.equal(statusWatchCandidate(helper, {}), false);
  assert.equal(grantStatusWatch(watches, helper, false, 0), false);
  assert.equal(grantStatusWatch(watches, helper, true, 0), true);
  assert.deepEqual(expireStatusWatches(watches, STATUS_WATCH_TTL_MS), [helper]);
  for (let i = 0; i < STATUS_CACHE_CAP; i++) {
    queue.set(String(i), { status: PILOT_AGENTS[0].status, at: 0 });
    watches.set(String(i), 0);
  }
  assert.equal(retainPendingStatus(queue, PILOT_AGENTS[0].status, 1), false);
  assert.equal(grantStatusWatch(watches, helper, true, 1), false);
});

test('bounded callback generations never revive an evicted verification', () => {
  const versions = createMeshEventVersions(); const old = versions.bump('status', helper);
  for (let i = 0; i < 1024; i++) versions.bump('status', String(i));
  assert.equal(versions.current('status', helper, old), false);
  versions.bump('status', helper);
  assert.equal(versions.current('status', helper, old), false);
});

import * as squad from './forum-squad';
import { validateForumNeed, validateForumStatus, reopenForumNeed } from './identity/check';

test('pending need removal keeps its own scope when live and removal delivery reorder', () => {
  const versions = createMeshEventVersions();
  const queue = new Map<string, squad.PendingNeedEntry>();
  const removalGen = versions.bump('need-remove', need.id);
  const removalKey = squad.pendingNeedKey(need.id, true);
  const removal = { removed: 1 as const, action: 'remove' as const, kind: 'need' as const, id: need.id, forumId: PILOT_FORUM_ID };
  const entry = { data: removal, objectId: need.id, parentId: PILOT_FORUM_ID, gen: removalGen, at: 0,
    fromRemoval: true, reason: 'owner' as const };
  assert.equal(squad.retainPendingNeed(queue, removalKey, entry, 0), true);
  const liveGen = versions.bump('need', need.id);
  assert.equal(squad.retainPendingNeed(queue, squad.pendingNeedKey(need.id), { ...entry, data: need, fromRemoval: false, gen: liveGen }, 1), true);
  assert.equal(queue.size, 2);
  queue.delete(squad.pendingNeedKey(need.id)); // Bad live update must not erase the removal.
  const retry = queue.get(removalKey)!;
  assert.equal(squad.pendingNeedRetry(retry, 2, PILOT_OWNER), 'retry');
  assert.equal(versions.current(retry.fromRemoval ? 'need-remove' : 'need', retry.objectId, retry.gen), true);
  assert.equal(authorizeForumMeshRemoval({ removal, mapKey: retry.objectId, signer: PILOT_OWNER,
    owner: PILOT_OWNER, subject: undefined, forumId: PILOT_FORUM_ID }), true);
  squad.prunePendingNeeds(queue, squad.PENDING_NEED_TTL_MS + 1);
  assert.equal(queue.size, 0);
});

test('need watches require verified context and role discovery has nonrenewable bounds', () => {
  const watches = new Map<string, squad.ForumWatch>();
  assert.equal(squad.grantForumWatch(watches, 'need', need.id, false, 0), false);
  assert.equal(squad.grantForumWatch(watches, 'offers', need.id, false, 0), false);
  assert.equal(watches.size, 0);
  for (let i = 0; i < 1000; i++) squad.grantForumWatch(watches, 'role', `role-${i}`, false, 0);
  assert.equal(watches.size, squad.ROLE_PROBE_CAP);
  assert.equal(squad.grantForumWatch(watches, 'role', 'role-0', false, squad.ROLE_PROBE_TTL_MS - 1), false);
  // A verified membership promotes only its own probe; the flood cannot renew the rest.
  squad.grantForumWatch(watches, 'role', 'role-1', true, 1);
  const expired = squad.expireForumWatches(watches, squad.ROLE_PROBE_TTL_MS);
  assert.ok(expired.includes('role:role-0'));
  assert.equal(watches.size, 1);
  assert.equal(squad.grantForumWatch(watches, 'need', need.id, true, 2), true);
  assert.equal(squad.expireForumWatches(watches, squad.FORUM_WATCH_TTL_MS + 2).length, 2);
});

test('verified listener limits apply per kind and across all kinds', () => {
  const watches = new Map<string, squad.ForumWatch>();
  for (let i = 0; i < 1000; i++) squad.grantForumWatch(watches, 'role', `role-${i}`, true, 0);
  assert.equal(watches.size, squad.FORUM_WATCH_PER_KIND);
  for (let i = 0; i < 1000; i++) {
    const id = `need_${seaToPrincipalKey(helper)}_${i.toString(16).padStart(32, '0')}`;
    squad.grantForumWatch(watches, 'need', id, true, 0);
  }
  assert.equal(watches.size, squad.FORUM_WATCH_CAP);
  assert.equal(squad.grantForumWatch(watches, 'offers', need.id, true, 0), false);
});

test('agent status cannot exhaust revisions and owner can override the accepted future edge', () => {
  const status = PILOT_AGENTS[0].status; const now = 2_000_000_000;
  assert.equal(validateForumStatus({ ...status, lastUpdate: Number.MAX_SAFE_INTEGER }), false);
  assert.equal(squad.statusRevisionAllowed({ ...status, lastUpdate: Number.MAX_SAFE_INTEGER - 1 }, helper, PILOT_OWNER, now), false);
  const edge = { ...status, lastUpdate: now + 299 };
  assert.equal(squad.statusRevisionAllowed(edge, helper, PILOT_OWNER, now), true);
  const updated = { ...edge, lastUpdate: edge.lastUpdate + 1 };
  assert.equal(updated.lastUpdate, edge.lastUpdate + 1);
  assert.equal(squad.statusRevisionAllowed(updated, PILOT_OWNER, PILOT_OWNER, now), true);
  assert.equal(squad.statusRevisionAllowed(updated, helper, PILOT_OWNER, now), false);
});

test('subject closes exactly the admitted successor and preserves an owner reopen', () => {
  const g = graph(); const closure = { graph: g, postedOffers: new Map([[offer.id, offer]]), now: 1000 };
  assert.equal(validateForumNeed({ ...closed, hamState: Number.MAX_SAFE_INTEGER }), false);
  for (const hamState of [need.hamState + 2, Number.MAX_SAFE_INTEGER - 1]) {
    const forged = { ...closed, hamState };
    assert.equal(authorizeForumNeed(forged, need.subject, PILOT_OWNER, PILOT_FORUM_ID, need, closure), false);
    assert.equal(authorizeForumNeed(forged, need.subject, PILOT_OWNER, PILOT_FORUM_ID, undefined, closure, need), false);
    assert.equal(pendingClosureContext(forged, need.subject, PILOT_OWNER, undefined, need), undefined);
  }
  assert.equal(authorizeForumNeed(closed, need.subject, PILOT_OWNER, PILOT_FORUM_ID, need, closure), true);
  const reopened = reopenForumNeed({ graph: g, writer: PILOT_OWNER, need: closed, now: 1000 });
  assert.equal(reopened.ok, true);
  assert.equal(reopened.need?.hamState, closed.hamState + 1);
});

test('pilot removal listeners do not require a published mesh status', () => {
  const watches = new Map<string, number>();
  for (const agent of PILOT_AGENTS) assert.equal(grantStatusWatch(watches, agent.status.seaPubkey, true, 0), true);
  const status = PILOT_AGENTS.find(agent => agent.status.state === 'emergency')!.status;
  assert.ok(watches.has(status.seaPubkey));
  const removal = { removed: 1 as const, action: 'remove' as const, forumId: PILOT_FORUM_ID, id: status.id, seaPubkey: status.seaPubkey };
  assert.equal(squad.authorizeForumAgentRemoval({ removal, mapKey: status.seaPubkey, signer: PILOT_OWNER,
    forumOwner: PILOT_OWNER, forumId: PILOT_FORUM_ID }), true);
  const roster = squad.composeForumRoster({ sample: PILOT_AGENTS, mesh: [],
    admitted: new Set(PILOT_AGENTS.map(a => a.status.seaPubkey)), removed: new Set([status.seaPubkey]) });
  assert.equal(roster.some(a => a.status.seaPubkey === status.seaPubkey), false);
});

test('new owner admission advances stale open or closed cache without accepting rollback', () => {
  const admitted = { ...need, hamState: need.hamState + 2 };
  const latest = { ...closed, hamState: admitted.hamState + 1 };
  const closure = { graph: graph(), postedOffers: new Map([[offer.id, offer]]), now: 1000 };
  for (const known of [need, closed]) {
    assert.equal(authorizeForumNeed(latest, need.subject, PILOT_OWNER, PILOT_FORUM_ID, known, closure, admitted), true);
    assert.ok(pendingClosureContext(latest, need.subject, PILOT_OWNER, known, admitted));
  }
  const newer = { ...need, hamState: latest.hamState + 1 };
  assert.equal(authorizeForumNeed(latest, need.subject, PILOT_OWNER, PILOT_FORUM_ID, newer, closure, admitted), false);
  assert.equal(pendingClosureContext(latest, need.subject, PILOT_OWNER, newer, admitted), undefined);
  assert.equal(authorizeForumNeed(latest, need.subject, PILOT_OWNER, PILOT_FORUM_ID, need, closure,
    { ...admitted, subject: helper }), false);
  assert.equal(authorizeForumNeed(latest, need.subject, PILOT_OWNER, PILOT_FORUM_ID, need, closure,
    { ...admitted, body: 'forged context' }), false);
});

test('verified chat flood, edits and composed render stay within row and size budgets', () => {
  const item = squad.buildForumStatement({ forumId: PILOT_FORUM_ID, author: helper, body: 'message',
    now: 1000, entropy: 'ab'.repeat(16) })!;
  let rows: typeof item[] = [];
  for (let i = 0; i < squad.FORUM_CHAT_CAP * 4; i++) {
    rows = squad.retainForumChat(rows, { ...item, id: `stmt-${i}`, ts: i });
    assert.ok(rows.length <= squad.FORUM_CHAT_CAP);
  }
  assert.equal(rows[0].id, `stmt-${squad.FORUM_CHAT_CAP * 3}`);
  const corrected = { ...rows[0], body: 'corrected' };
  rows = squad.retainForumChat(rows, corrected);
  assert.equal(rows.at(-1)!.body, 'corrected');
  assert.equal(rows.filter(row => row.id === corrected.id).length, 1);
  const oversized = { ...item, body: 'x'.repeat(squad.FORUM_CHAT_ROW_CHARS + 1) };
  assert.equal(squad.forumChatFits(oversized), false);
  assert.deepEqual(squad.retainForumChat(rows, oversized), rows);
  const rendered = squad.mergeForumChat({ pilot: [item], mesh: rows,
    local: rows.map(row => ({ ...row, id: `local-${row.id}` })), hidden: [] });
  assert.equal(rendered.length, squad.FORUM_CHAT_CAP);
});

test('chat removal watches rotate with retained deliveries and release evicted listeners', () => {
  const watches = new Map<string, number>(); const released: string[] = [];
  const item = squad.buildForumStatement({ forumId: PILOT_FORUM_ID, author: helper, body: 'line', now: 1, entropy: 'bc'.repeat(16) })!;
  let rows: typeof item[] = [];
  for (let i = 0; i < squad.FORUM_CHAT_CAP * 3; i++) {
    const id = `stmt-window-${i}`;
    rows = squad.retainForumChat(rows, { ...item, id });
    assert.equal(squad.grantChatRemovalWatch({ watches, key: id, verified: true, now: i, onEvict: key => released.push(key) }), true);
    assert.deepEqual([...watches.keys()], rows.map(row => row.id));
  }
  assert.equal(released.length, squad.FORUM_CHAT_CAP * 2);
  const edited = rows[0];
  rows = squad.retainForumChat(rows, { ...edited, body: 'edit' });
  assert.equal(squad.grantChatRemovalWatch({ watches, key: edited.id, verified: true, now: 9999 }), false);
  assert.deepEqual([...watches.keys()], rows.map(row => row.id));
});

test('authenticated pending closure survives older live replay and retains retry validity', () => {
  const versions = createMeshEventVersions();
  const gen = versions.bump('need-pending', closed.id);
  const entry: squad.PendingNeedEntry = { data: closed, objectId: closed.id, parentId: PILOT_FORUM_ID,
    reason: 'closure', context: closed, at: 0, gen };
  versions.bump('need', need.id);
  assert.equal(squad.pendingClosureDominates(entry, need, 1), true);
  assert.equal(squad.pendingClosureDominates(entry, { ...closed, stated: 1 }, 1), true);
  assert.equal(versions.current('need-pending', closed.id, entry.gen), true);
  assert.equal(squad.pendingClosureDominates(entry, closed, 1), false);
  assert.equal(authorizeForumNeed(closed, need.subject, PILOT_OWNER, PILOT_FORUM_ID, need,
    { graph: graph(), postedOffers: new Map([[offer.id, offer]]), now: 1000 }), true);
  assert.equal(squad.pendingClosureDominates(entry, { ...need, hamState: closed.hamState + 1 }, 1), false);
  assert.equal(squad.pendingClosureDominates(entry, need, squad.PENDING_NEED_TTL_MS), false);
});

test('tombstone flood stays bounded and replay does not extend expiration', () => {
  const tombs = new Map<string, number>();
  for (let i = 0; i < squad.CHAT_TOMBSTONE_CAP * 4; i++) {
    squad.retainChatTombstone(tombs, `stmt-removed-${i}`, 0);
    assert.ok(tombs.size <= squad.CHAT_TOMBSTONE_CAP);
  }
  assert.equal(tombs.has('stmt-removed-0'), false);
  const id = [...tombs.keys()][0];
  assert.equal(squad.retainChatTombstone(tombs, id, squad.CHAT_TOMBSTONE_TTL_MS - 1), false);
  assert.equal(tombs.get(id), 0);
  assert.equal(squad.pruneChatTombstones(tombs, squad.CHAT_TOMBSTONE_TTL_MS), true);
  assert.equal(tombs.size, 0);
});

test('separate owner-signed admission survives a self-signed status replacement on a fresh reader', async () => {
  const { createRequire } = await import('node:module');
  const { signForumRecord, readForumSignature } = await import('./forum-sign');
  type Pair = import('./identity/sea').SeaPair;
  const sea = createRequire(import.meta.url)('gun/sea') as { pair: () => Promise<Pair> };
  const owner = await sea.pair(); const agent = await sea.pair();
  const status = { ...PILOT_AGENTS[0].status, seaPubkey: agent.pub,
    id: `status_${seaToPrincipalKey(agent.pub)}_${'ab'.repeat(16)}`, lastUpdate: 1 };
  const admission = await signForumRecord(status, owner);
  const latest = { ...status, state: 'emergency' as const, lastUpdate: 2 };
  const signedLatest = await signForumRecord(latest, agent);
  const verified = squad.parseForumAgentStatus(await readForumSignature(signedLatest, agent.pub))!;
  assert.equal(squad.forumStatusAdmission({ status: verified, mapKey: agent.pub, signer: agent.pub,
    forumOwner: owner.pub, forumId: PILOT_FORUM_ID, enrolled: false }), 'pending');
  const admitted = squad.parseForumAgentStatus(await readForumSignature(admission, owner.pub))!;
  assert.equal(squad.authorizeStatusAdmission(admitted, agent.pub, owner.pub, owner.pub, PILOT_FORUM_ID), true);
  assert.equal(squad.authorizeStatusAdmission(verified, agent.pub, agent.pub, owner.pub, PILOT_FORUM_ID), false);
  assert.equal(squad.authorizeStatusAdmission(admitted, helper, owner.pub, owner.pub, PILOT_FORUM_ID), false);
  assert.equal(squad.forumStatusAdmission({ status: verified, mapKey: agent.pub, signer: agent.pub,
    forumOwner: owner.pub, forumId: PILOT_FORUM_ID, enrolled: true }), 'enrolled');
});

test('offer withdrawal uses newer authenticated pending closure rather than installed open parent', () => {
  const pending = { data: closed, context: closed, reason: "closure" as const, gen: 1, at: 100, parentId: PILOT_FORUM_ID, objectId: need.id };
  const parent = squad.freshestOfferParent(need, pending, 101)!;
  assert.equal(parent, closed);
  assert.equal(authorizeForumOffer({ ...offer, stated: 0 }, helper, PILOT_FORUM_ID,
    { owner: PILOT_OWNER, subject: parent.subject }, { graph: graph(), need: parent, now: 1000 }), false);
  assert.equal(authorizeForumMeshRemoval({ removal: { removed: 1, action: 'remove', kind: 'offer',
    id: offer.id, need: need.id, forumId: PILOT_FORUM_ID }, mapKey: offer.id, signer: helper,
    owner: PILOT_OWNER, subject: parent.subject, forumId: PILOT_FORUM_ID, parentNeedId: need.id,
    resolved: parent.stated === 0 && parent.acceptedOffer === offer.id }), false);
  assert.equal(squad.freshestOfferParent(need, pending, 100 + squad.PENDING_NEED_TTL_MS), need);
  const reopened = { ...need, hamState: closed.hamState + 1 };
  assert.equal(squad.freshestOfferParent(reopened, pending, 101), reopened);
});

test('combined chat keeps recent local deliveries without trusting remote timestamps', () => {
  const item = squad.buildForumStatement({ forumId: PILOT_FORUM_ID, author: helper, body: 'mesh', now: 1000, entropy: 'cd'.repeat(16) })!;
  let mesh: typeof item[] = [];
  for (let i = 0; i < squad.FORUM_CHAT_CAP; i++) mesh = squad.retainForumChat(mesh, { ...item, id: `mesh-${i}`, ts: 99999999999 });
  const localItem = { ...item, id: 'local-new', body: 'local only' };
  const local = squad.retainForumChat([], localItem);
  let view = squad.mergeForumChat({ pilot: [], mesh, local, hidden: [] });
  assert.equal(view.length, squad.FORUM_CHAT_CAP);
  assert.ok(view.some(row => row.id === localItem.id));
  const echo = { ...localItem, body: 'verified mesh' };
  mesh = squad.retainForumChat(mesh, echo);
  view = squad.mergeForumChat({ pilot: [], mesh, local, hidden: [] });
  assert.deepEqual(view.filter(row => row.id === localItem.id), [echo]);
});

test('unsigned graph cannot supply ownership or Check grants for non-fixture needs', () => {
  const primary = graph(); const trusted = createMemorySeeAcl();
  const overlay = squad.overlaySeeGraph(primary, trusted);
  assert.equal(overlay.ownerOf(need.id), undefined);
  assert.equal(overlay.hasObject(need.id), false);
  assert.equal(authorizeForumOffer(offer, helper, PILOT_FORUM_ID, undefined,
    { graph: overlay, need, now: 1000 }), false);
});

test('accepted offer history is bounded per need and globally, including oversized rows', () => {
  let rows = new Map<string, ForumOffer>();
  for (let parent = 0; parent < 12; parent++) for (let i = 0; i < 100; i++) {
    const next = { ...offer, id: `${offer.id}-${i}`, need: `${need.id}-${parent}` };
    rows = squad.retainForumOffer(rows, next);
    assert.ok(rows.size <= squad.FORUM_OFFER_CAP);
    assert.ok([...rows.values()].filter(row => row.need === next.need).length <= squad.FORUM_OFFER_PER_NEED_CAP);
  }
  const huge = { ...offer, body: 'x'.repeat(squad.FORUM_OFFER_MAX_CHARS) };
  assert.equal(squad.forumOfferFits(huge), false);
  assert.deepEqual(squad.retainForumOffer(rows, huge), rows);
  assert.equal(squad.forumOfferFits({ ...offer, sig: 'x'.repeat(squad.FORUM_OFFER_MAX_CHARS) }), false);
});

test('public-vector squad fixture cannot connect, publish, or restore former mesh authority', async () => {
  const { PILOT_MESH_ENABLED } = await import('./forum-squad-fixture');
  assert.equal(PILOT_MESH_ENABLED, false);
  const { readFileSync } = await import('node:fs');
  const source = readFileSync('components/SquadForum.tsx', 'utf8');
  assert.match(source, /if \(!PILOT_MESH_ENABLED \|\| !register\) return;/);
  assert.match(source, /if \(!PILOT_MESH_ENABLED \|\| !gun\) return false;/);
  assert.match(source, /if \(!PILOT_MESH_ENABLED\) return;\s+const loaded = parseNeedHighWater/);
  assert.match(source, /if \(!PILOT_MESH_ENABLED\) return "local";/);
});

test('unsigned cached status cannot populate the live roster on reload', () => {
  const fixture = PILOT_AGENTS[0];
  const cached = { ...fixture.status, task: 'unverified cached task', state: 'emergency' as const, lastUpdate: 20 };
  const restored = restoreForumStatusCache(JSON.stringify([cached]), PILOT_FORUM_ID);
  const roster = squad.composeForumRoster({ sample: [fixture], mesh: [...restored.mesh.values()], removed: new Set() });
  assert.equal(roster[0].status.task, fixture.status.task);
  assert.equal(roster[0].drawerSource, 'sample');
  assert.equal(restored.mesh.size, 0);
  // Replay protection survives even though cached content cannot be displayed.
  assert.equal(cacheForumStatus(restored.highWater, { ...cached, lastUpdate: 19 }), false);
  assert.equal(cacheForumStatus(restored.highWater, cached), true);
  const fresh = { ...cached, task: 'verified fresh task', lastUpdate: 21 };
  assert.equal(cacheForumStatus(restored.highWater, fresh), true);
  // Updating the floor is not itself display admission.
  assert.equal(restored.mesh.size, 0);
  const admitted = squad.composeForumRoster({ sample: [fixture], mesh: [fresh], removed: new Set() });
  assert.equal(admitted[0].status.task, fresh.task);
  assert.equal(admitted[0].drawerSource, 'status-only');
});

test('status restoration handles corrupt and foreign-forum caches without live rows', () => {
  for (const raw of [null, '{', '{}', JSON.stringify([{ ...PILOT_AGENTS[0].status, forumId: 'wrong' }])]) {
    const restored = restoreForumStatusCache(raw, PILOT_FORUM_ID);
    assert.equal(restored.highWater.size, 0);
    assert.equal(restored.mesh.size, 0);
  }
});
