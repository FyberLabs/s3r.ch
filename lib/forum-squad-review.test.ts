import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PILOT_AGENTS, PILOT_NEEDS, PILOT_OWNER, PILOT_FORUM_ID } from './forum-squad-fixture';
import { applySeeGrant, seaToPrincipalKey, type ForumOffer } from './identity/check';
import { createMemorySeeAcl } from './identity/see-acl';
import {
  forumOfferCacheKey, offersForNeed, offerBlockedByCancel, authorizeForumOffer,
  pendingClosureContext, needClosureStatus, authorizeForumNeed, needSignerCandidates,
  authorizeForumMeshRemoval, retainPendingStatus, prunePendingStatuses, cacheForumStatus,
  parseStatusHighWater, STATUS_CACHE_CAP, PENDING_STATUS_TTL_MS, STATUS_WATCH_TTL_MS,
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
