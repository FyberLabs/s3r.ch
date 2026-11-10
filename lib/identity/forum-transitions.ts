/**
 * Forum need/offer transitions consume Check permission results; Check does not
 * own forum state changes. This is the existing local consumer, pending the
 * upstream transition surface/vectors in SociACL #156 and s3r.ch #281.
 */
import {
  checkSee, checkForumSee,
  type AccessorId, type SeeGraph, type HandoffHint, type HopFactor,
} from "./check";
import {
  isSeaPubkey, mintForumOfferId, validateForumNeed, validateForumOffer,
  type ForumNeed, type ForumNeedDecision, type ForumOffer, type ForumOfferDecision,
} from "./forum-check";

/**
 * Next need row when Check already allowed the writer.
 * `hamState` must rise. `id`, `forumId`, `subject`, and `body` stay.
 * `severity`, `spec`, `stated`, and `acceptedOffer` stay.
 * Closing and reopening are offer verbs.
 * Does not elect. Does not read a hint or a hop.
 * Does not look at why Check allowed.
 */
export function transitionForumNeed(
  current: ForumNeed,
  next: ForumNeed,
  see: { allowed: boolean; reason: string },
): ForumNeedDecision {
  if (!validateForumNeed(current) || !validateForumNeed(next)) {
    return { ok: false, reason: "bad-need", elect: false };
  }
  if (next.id !== current.id || next.forumId !== current.forumId || next.subject !== current.subject) {
    return { ok: false, reason: "bad-need", elect: false };
  }
  if (next.body !== current.body) {
    return { ok: false, reason: "body", elect: false };
  }
  if (next.severity !== current.severity) {
    return { ok: false, reason: "severity", elect: false };
  }
  if ((next.spec ?? "") !== (current.spec ?? "")) {
    return { ok: false, reason: "spec", elect: false };
  }
  if (next.hamState <= current.hamState) {
    return { ok: false, reason: "ham", elect: false };
  }
  if (next.stated !== current.stated) {
    return { ok: false, reason: "stated", elect: false };
  }
  if ((next.acceptedOffer ?? "") !== (current.acceptedOffer ?? "")) {
    return { ok: false, reason: "accepted-offer", elect: false };
  }
  if (!see.allowed) return { ok: false, reason: see.reason, elect: false };
  return { ok: true, need: { ...next }, elect: false };
}

/**
 * Accept `next` when Check see allows `writer` on `current.id`.
 * Any allowed Check result passes. A hint and a hop are ignored.
 * `id`, `forumId`, and `subject` stay. `hamState` must rise.
 * The admitted owner is not rewritten. This does not elect.
 */
export function acceptForumNeedTransition(input: {
  graph: SeeGraph;
  current: ForumNeed;
  next: ForumNeed;
  writer: AccessorId;
  now: number;
  hint?: HandoffHint;
  hop?: HopFactor;
}): ForumNeedDecision & { owner: AccessorId | undefined } {
  void input.hint;
  void input.hop;
  const ownerBefore = input.graph.ownerOf(input.current.id);
  const see = checkSee(input.graph, input.current.id, input.writer, input.now);
  const ownerAfter = input.graph.ownerOf(input.current.id);
  if (ownerBefore !== ownerAfter) {
    return { ok: false, reason: "owner", elect: false, owner: ownerAfter };
  }
  const decided = transitionForumNeed(input.current, input.next, see);
  return { ...decided, owner: ownerAfter };
}

/**
 * Check see does not close a need. A see-holder may offer help.
 * Closing is an accept by the owner or the subject, and that verb is not shipped.
 * This does not elect. A hint and a hop are ignored.
 */
export function resolveForumNeed(input: {
  graph: SeeGraph;
  writer: AccessorId;
  need: ForumNeed;
  now: number;
  hint?: HandoffHint;
  hop?: HopFactor;
}): ForumNeedDecision & { owner: AccessorId | undefined } {
  void input.hint;
  void input.hop;
  const owner = input.graph.ownerOf(input.need.id);
  if (!validateForumNeed(input.need)) {
    return { ok: false, reason: "bad-need", elect: false, owner };
  }
  const see = checkSee(input.graph, input.need.id, input.writer, input.now);
  if (!see.allowed) return { ok: false, reason: see.reason, elect: false, owner };
  return { ok: false, reason: "offer", elect: false, owner };
}

type OfferResult = ForumOfferDecision & { owner: AccessorId | undefined };

function offerOwner(graph: SeeGraph, need: ForumNeed): AccessorId | undefined {
  return graph.ownerOf(need.id);
}

function heldLiveOffer(
  postedOffers: ReadonlyMap<string, ForumOffer>,
  offer: ForumOffer,
  need: ForumNeed,
  allowCancelled = false,
): ForumOffer | null {
  const posted = postedOffers.get(offer.id);
  if (!posted || !validateForumOffer(posted) || (posted.stated !== 1 && !allowCancelled)) return null;
  if (posted.id !== offer.id || posted.need !== need.id || posted.forumId !== need.forumId) return null;
  if (posted.helper !== offer.helper || posted.body !== offer.body || posted.artifacts !== offer.artifacts) {
    return null;
  }
  if (posted.need !== offer.need || posted.forumId !== offer.forumId) return null;
  return posted;
}

/**
 * Check see on the need posts a live offer. It does not set the need to `stated` 0.
 * The helper authors the row. This never admits ACL object ownership.
 * A hint and a hop are ignored.
 */
export function offerForumHelp(input: {
  graph: SeeGraph;
  writer: AccessorId;
  need: ForumNeed;
  body: string;
  now: number;
  entropy: string;
  artifacts?: string;
  hint?: HandoffHint;
  hop?: HopFactor;
}): OfferResult {
  void input.hint;
  void input.hop;
  const owner = offerOwner(input.graph, input.need);
  const body = input.body.trim();
  if (!validateForumNeed(input.need)) return { ok: false, reason: "bad-need", elect: false, owner };
  if (body.length === 0 || body.length > 280) return { ok: false, reason: "body", elect: false, owner };
  if (!isSeaPubkey(input.writer)) return { ok: false, reason: "writer", elect: false, owner };
  const see = checkForumSee(input.graph, input.need.id, input.writer, input.now);
  if (!see.allowed) return { ok: false, reason: see.reason, elect: false, owner };
  const id = mintForumOfferId(input.writer, input.entropy);
  if (!id) return { ok: false, reason: "entropy", elect: false, owner };
  const offer: ForumOffer = {
    id,
    need: input.need.id,
    forumId: input.need.forumId,
    helper: input.writer,
    body,
    artifacts: input.artifacts ?? "",
    stated: 1,
  };
  if (!validateForumOffer(offer)) return { ok: false, reason: "bad-offer", elect: false, owner };
  return { ok: true, offer, elect: false, owner };
}

/**
 * Owner or subject accepts one live posted offer.
 * The helper must still pass Check see. A caller-supplied offer that was not
 * posted is refused. This sets `acceptedOffer` and `stated` 0. It does not elect.
 */
export function acceptForumOffer(input: {
  graph: SeeGraph;
  writer: AccessorId;
  need: ForumNeed;
  offer: ForumOffer;
  postedOffers: ReadonlyMap<string, ForumOffer>;
  now: number;
  hint?: HandoffHint;
  hop?: HopFactor;
}): OfferResult {
  void input.hint;
  void input.hop;
  const owner = offerOwner(input.graph, input.need);
  if (!validateForumNeed(input.need)) return { ok: false, reason: "bad-need", elect: false, owner };
  if (!input.graph.hasObject(input.need.id)) return { ok: false, reason: "missing-object", elect: false, owner };
  if (input.need.stated !== 1) return { ok: false, reason: "stated", elect: false, owner };
  if (input.writer !== owner && input.writer !== input.need.subject) {
    return { ok: false, reason: "party", elect: false, owner };
  }
  const posted = heldLiveOffer(input.postedOffers, input.offer, input.need);
  if (!posted) return { ok: false, reason: "unposted", elect: false, owner };
  const helperSee = checkForumSee(input.graph, input.need.id, posted.helper, input.now);
  if (!helperSee.allowed) return { ok: false, reason: helperSee.reason, elect: false, owner };
  const need: ForumNeed = {
    ...input.need,
    stated: 0,
    acceptedOffer: posted.id,
    hamState: input.need.hamState + 1,
  };
  if (!validateForumNeed(need)) return { ok: false, reason: "bad-need", elect: false, owner };
  return { ok: true, offer: posted, need, elect: false, owner };
}

/**
 * Owner or subject cancels that offer. The need stays open.
 */
export function declineForumOffer(input: Parameters<typeof checkForumOfferCancellation>[0]): OfferResult {
  return checkForumOfferCancellation(input, false);
}

/** Reauthorize the cancellation tail after an identical cancellation self-echo. */
export function continueForumOfferCancellation(input: Parameters<typeof checkForumOfferCancellation>[0]): OfferResult {
  return checkForumOfferCancellation(input, true);
}

function checkForumOfferCancellation(input: {
  graph: SeeGraph;
  writer: AccessorId;
  need: ForumNeed;
  offer: ForumOffer;
  postedOffers: ReadonlyMap<string, ForumOffer>;
  now: number;
  hint?: HandoffHint;
  hop?: HopFactor;
}, allowCancelled: boolean): OfferResult {
  void input.hint;
  void input.hop;
  void input.now;
  const owner = offerOwner(input.graph, input.need);
  if (!validateForumNeed(input.need)) return { ok: false, reason: "bad-need", elect: false, owner };
  if (!input.graph.hasObject(input.need.id)) return { ok: false, reason: "missing-object", elect: false, owner };
  if (input.need.stated !== 1) return { ok: false, reason: "stated", elect: false, owner };
  if (input.writer !== owner && input.writer !== input.need.subject) {
    return { ok: false, reason: "party", elect: false, owner };
  }
  const posted = heldLiveOffer(input.postedOffers, input.offer, input.need, allowCancelled);
  if (!posted) return { ok: false, reason: "unposted", elect: false, owner };
  return { ok: true, offer: { ...posted, stated: 0 }, need: input.need, elect: false, owner };
}

/**
 * The helper withdraws a live offer. A resolved need refuses withdrawal of the
 * offer it names. Earlier offers are not removed by this verb.
 */
export function withdrawForumOffer(input: {
  graph: SeeGraph;
  writer: AccessorId;
  need: ForumNeed;
  offer: ForumOffer;
  postedOffers: ReadonlyMap<string, ForumOffer>;
  now: number;
  hint?: HandoffHint;
  hop?: HopFactor;
}): OfferResult {
  void input.hint;
  void input.hop;
  void input.now;
  const owner = offerOwner(input.graph, input.need);
  if (!validateForumNeed(input.need)) return { ok: false, reason: "bad-need", elect: false, owner };
  const posted = heldLiveOffer(input.postedOffers, input.offer, input.need);
  if (!posted) return { ok: false, reason: "unposted", elect: false, owner };
  if (input.writer !== posted.helper) return { ok: false, reason: "helper", elect: false, owner };
  if (input.need.stated === 0 && input.need.acceptedOffer === posted.id) {
    return { ok: false, reason: "resolved", elect: false, owner };
  }
  return { ok: true, offer: { ...posted, stated: 0 }, elect: false, owner };
}

/**
 * The owner reopens. That sets `stated` 1 and clears `acceptedOffer`.
 * Earlier offers stay. The subject cannot reopen. This does not elect.
 */
export function reopenForumNeed(input: {
  graph: SeeGraph;
  writer: AccessorId;
  need: ForumNeed;
  now: number;
  hint?: HandoffHint;
  hop?: HopFactor;
}): OfferResult {
  void input.hint;
  void input.hop;
  void input.now;
  const owner = offerOwner(input.graph, input.need);
  if (!validateForumNeed(input.need)) return { ok: false, reason: "bad-need", elect: false, owner };
  if (!input.graph.hasObject(input.need.id)) return { ok: false, reason: "missing-object", elect: false, owner };
  if (input.writer !== owner) return { ok: false, reason: "owner", elect: false, owner };
  if (input.need.stated !== 0) return { ok: false, reason: "open", elect: false, owner };
  const need: ForumNeed = {
    id: input.need.id,
    forumId: input.need.forumId,
    subject: input.need.subject,
    severity: input.need.severity,
    body: input.need.body,
    stated: 1,
    hamState: input.need.hamState + 1,
    ts: input.need.ts,
  };
  if (input.need.spec !== undefined) need.spec = input.need.spec;
  if (!validateForumNeed(need)) return { ok: false, reason: "bad-need", elect: false, owner };
  return { ok: true, need, elect: false, owner };
}
