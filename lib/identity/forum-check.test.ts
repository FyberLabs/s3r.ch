import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { itemSoul } from "./check";
import {
  acceptForumNeedTransition,
  acceptForumRoles,
  checkSee,
  forumAgentSoul,
  forumAlarmPins,
  forumAlarmSoul,
  forumChatTag,
  forumChatTagPresent,
  forumChatTagWire,
  forumEmergencyAlarm,
  forumNeedSoul,
  forumRoleSoul,
  forumStatementSoul,
  forumSubtaskSoul,
  forumTemplateSoul,
  forumUpdateSoul,
  isSeaPubkey,
  isSeparateChatSoul,
  acceptForumOffer,
  declineForumOffer,
  forumOfferSoul,
  mintForumOfferId,
  offerForumHelp,
  reopenForumNeed,
  withdrawForumOffer,
  resolveForumNeed,
  sameEmbeddedPrincipal,
  seaToPrincipalKey,
  type ForumNeed,
  type HandoffHint,
  type HopFactor,
} from "./check";
import { createMemorySeeAcl } from "./see-acl";

const doc = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "vectors/forums.json"), "utf8"),
) as {
  forumId: string;
  needId: string;
  statusId: string;
  specId: string;
  seaPubkey: string;
  secondPubkey: string;
  linkedWallet: string;
  souls: Record<string, string>;
  chatCollection: string;
  refusedChatSouls: string[];
  chat: {
    extra: string[];
    joined: string;
    duplicateExtra: string[];
    duplicateJoined: string;
    reject: string[];
  };
  resolve: {
    forumId: string;
    needId: string;
    subject: string;
    severity: string;
    open: { stated: number; hamState: number };
    resolved: { stated: number; hamState: number };
    soul: string;
    pinsOpen: boolean;
    pinsResolved: boolean;
    admittedOwner: null;
    alarmForumId: string;
    needForumId: string;
    pinned: number;
  };
  alarm: Array<{
    name: string;
    alarmForumId: string;
    needForumId: string;
    needId: string;
    severity: string;
    stated: number;
    pinned: number;
    tiles: string[];
    pins: boolean;
    alarm: boolean;
  }>;
  roles: Array<{
    name: string;
    mode: string;
    rows: Array<{ role: string; principal: string }>;
    accept: boolean;
  }>;
};

const NOW = 1_700_000_010;

function need(stated: 0 | 1, hamState: number, subject = doc.resolve.subject): ForumNeed {
  return {
    id: doc.needId,
    forumId: doc.forumId,
    subject,
    severity: "emergency",
    body: "blocked",
    stated,
    hamState,
    ts: 11,
  };
}

describe("forum souls", () => {
  it("matches the filled vector strings", () => {
    assert.equal(forumAgentSoul(doc.forumId, doc.seaPubkey), doc.souls.agent);
    assert.equal(forumNeedSoul(doc.forumId, doc.needId), doc.souls.need);
    assert.equal(forumOfferSoul(doc.forumId, doc.needId, doc.souls.offer.split("/").at(-1) ?? ""), doc.souls.offer);
    assert.equal(forumAlarmSoul(doc.forumId), doc.souls.alarm);
    assert.equal(forumTemplateSoul(doc.forumId), doc.souls.template);
    assert.equal(forumRoleSoul(doc.forumId, "treasurer", doc.seaPubkey), doc.souls.role);
    assert.equal(forumSubtaskSoul(doc.forumId, doc.seaPubkey, doc.statusId), doc.souls.subtask);
    assert.equal(forumUpdateSoul(doc.forumId, doc.seaPubkey, doc.needId), doc.souls.update);
    assert.equal(forumChatTag(doc.forumId), doc.souls.chatTag);
    assert.equal(doc.chatCollection, "s3rch/items");
  });

  it("keeps the SEA pubkey as the agent segment", () => {
    const soul = forumAgentSoul(doc.forumId, doc.seaPubkey);
    assert.equal(soul.split("/").at(-1), doc.seaPubkey);
    assert.equal(sameEmbeddedPrincipal(doc.seaPubkey, doc.statusId), true);
    assert.equal(sameEmbeddedPrincipal(doc.seaPubkey, doc.needId), true);
    assert.equal(sameEmbeddedPrincipal(doc.secondPubkey, doc.needId), false);
    assert.equal(isSeaPubkey(doc.linkedWallet), false);
    assert.equal(isSeaPubkey("panopticon-oauth-subject"), false);
    assert.throws(() => forumAgentSoul(doc.forumId, doc.linkedWallet), /bad-principal/);
    assert.throws(() => forumAgentSoul(doc.needId, doc.seaPubkey), /bad-id/);
    assert.throws(() => forumNeedSoul(doc.forumId, doc.forumId), /bad-id/);
    assert.throws(() => forumRoleSoul(doc.forumId, "Treasurer", doc.seaPubkey), /bad-role/);
    assert.throws(() => forumRoleSoul(doc.forumId, "practice manager", doc.seaPubkey), /bad-role/);
    assert.throws(() => forumRoleSoul(doc.forumId, "chat", doc.seaPubkey), /bad-role/);
    assert.throws(
      () =>
        forumSubtaskSoul(
          doc.forumId,
          doc.seaPubkey,
          "ext_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        ),
      /bad-id/,
    );
  });

  it("does not build a chat soul", () => {
    const souls = [
      forumAgentSoul(doc.forumId, doc.seaPubkey),
      forumNeedSoul(doc.forumId, doc.needId),
      forumAlarmSoul(doc.forumId),
      forumTemplateSoul(doc.forumId),
      forumRoleSoul(doc.forumId, "treasurer", doc.seaPubkey),
      forumSubtaskSoul(doc.forumId, doc.seaPubkey, doc.statusId),
      forumUpdateSoul(doc.forumId, doc.seaPubkey, doc.needId),
    ];
    for (const soul of souls) assert.equal(isSeparateChatSoul(soul), false);
    for (const refused of doc.refusedChatSouls) assert.equal(isSeparateChatSoul(refused), true);
    const item = forumStatementSoul("statement-1");
    assert.equal(item, itemSoul("statement-1"));
    assert.equal(item, `${doc.chatCollection}/statement-1`);
    assert.equal(isSeparateChatSoul(item), false);
    assert.equal(isSeparateChatSoul("s3rch/chat"), true);
  });
});

describe("forum chat tags", () => {
  it("joins extras and rejects the vector rows", () => {
    assert.equal(forumChatTagWire(doc.forumId, doc.chat.extra), doc.chat.joined);
    assert.equal(forumChatTagWire(doc.forumId, doc.chat.duplicateExtra), doc.chat.duplicateJoined);
    for (const rejected of doc.chat.reject) {
      assert.equal(forumChatTagWire(doc.forumId, [rejected]), null, rejected);
    }
    const joined = forumChatTagWire(doc.forumId, ["report"]);
    assert.ok(joined);
    assert.equal(forumChatTagPresent(joined, doc.forumId), true);
    assert.equal(joined.split(",").includes("chat"), false);
  });
});

describe("forum roles and alarm", () => {
  it("accepts both template modes from the vector", () => {
    for (const row of doc.roles) {
      assert.equal(acceptForumRoles(row.mode, row.rows), row.accept, row.name);
    }
    assert.equal(acceptForumRoles("distinct-principals", []), true);
    assert.equal(acceptForumRoles("role-labels", []), true);
    assert.equal(acceptForumRoles(" distinct-principals", []), false);
  });

  it("fans in tiles and the pinned need", () => {
    for (const row of doc.alarm) {
      const alarm = { forumId: row.alarmForumId, need: row.needId, pinned: row.pinned };
      const open = {
        id: row.needId,
        forumId: row.needForumId,
        severity: row.severity,
        stated: row.stated,
      };
      assert.equal(forumAlarmPins(alarm, open), row.pins, row.name);
      assert.equal(forumEmergencyAlarm(row.tiles, alarm, open), row.alarm, row.name);
    }
  });
});

describe("resolve need", () => {
  it("denies a missing admission and does not elect", () => {
    const acl = createMemorySeeAcl();
    const open = need(1, doc.resolve.open.hamState);
    const hint: HandoffHint = {
      principal: doc.secondPubkey,
      target: doc.needId,
      verb: "see",
      context: "resolve",
    };
    const hop: HopFactor = { channel: "convention-badge" };
    const denied = resolveForumNeed({
      graph: acl,
      writer: doc.seaPubkey,
      need: open,
      now: NOW,
      hint,
      hop,
    });
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.reason, "missing-object");
    assert.equal(denied.elect, false);
    assert.equal(acl.ownerOf(doc.needId), undefined);
    assert.equal(doc.resolve.admittedOwner, null);
    const alarm = {
      forumId: doc.resolve.alarmForumId,
      need: doc.resolve.needId,
      pinned: doc.resolve.pinned,
    };
    assert.equal(
      forumAlarmPins(alarm, { ...open, severity: doc.resolve.severity }),
      doc.resolve.pinsOpen,
    );
  });

  it("lets Check see offer help and does not close the need", () => {
    const acl = createMemorySeeAcl();
    const open = need(1, 1);
    acl.putObject(open.id, doc.seaPubkey);
    const stranger = resolveForumNeed({
      graph: acl,
      writer: doc.secondPubkey,
      need: open,
      now: NOW,
      hint: { principal: doc.secondPubkey, target: open.id, verb: "see" },
    });
    assert.equal(stranger.ok, false);
    if (!stranger.ok) assert.equal(stranger.reason, "missing-grant");
    assert.equal(stranger.elect, false);
    assert.equal(acl.ownerOf(open.id), doc.seaPubkey);

    acl.stateSeeGrant(doc.seaPubkey, {
      claimId: open.id,
      accessor: doc.secondPubkey,
      from: 0,
      until: NOW + 1000,
    });
    assert.equal(checkSee(acl, open.id, doc.secondPubkey, NOW).allowed, true);
    assert.equal(checkSee(acl, open.id, doc.secondPubkey, NOW).reason, "see-grant");
    const byGrant = resolveForumNeed({
      graph: acl,
      writer: doc.secondPubkey,
      need: open,
      now: NOW,
    });
    assert.equal(byGrant.ok, false);
    if (!byGrant.ok) assert.equal(byGrant.reason, "offer");
    assert.equal(byGrant.elect, false);
    assert.equal(byGrant.owner, doc.seaPubkey);
    assert.equal(open.stated, 1);
    const offered = offerForumHelp({
      graph: acl,
      writer: doc.secondPubkey,
      need: open,
      body: "I can roll back step 3",
      now: NOW,
      entropy: "ab".repeat(16),
      hint: { principal: doc.secondPubkey, target: open.id, verb: "see" },
      hop: { channel: "convention-badge" },
    });
    assert.equal(offered.ok, true);
    assert.equal(offered.elect, false);
    if (offered.ok && offered.offer) assert.equal(offered.offer.stated, 1);
    assert.equal(open.stated, 1);
    assert.equal(acl.ownerOf(open.id), doc.seaPubkey);
    const alarm = { forumId: doc.forumId, need: doc.needId, pinned: 1 };
    assert.equal(
      forumAlarmPins(alarm, { id: doc.needId, forumId: doc.forumId, severity: "emergency", stated: 1 }),
      doc.resolve.pinsOpen,
    );
  });

  it("shows a cancel on the next Check and still does not let the owner close", () => {
    const acl = createMemorySeeAcl();
    const open = need(1, 1);
    acl.putObject(open.id, doc.seaPubkey);
    acl.stateSeeGrant(doc.seaPubkey, {
      claimId: open.id,
      accessor: doc.secondPubkey,
      from: 0,
      until: NOW + 1000,
    });
    assert.equal(checkSee(acl, open.id, doc.secondPubkey, NOW).allowed, true);
    acl.unstateSeeGrant(doc.seaPubkey, doc.secondPubkey, open.id);
    assert.equal(checkSee(acl, open.id, doc.secondPubkey, NOW).allowed, false);
    const cancelled = resolveForumNeed({
      graph: acl,
      writer: doc.secondPubkey,
      need: open,
      now: NOW,
    });
    assert.equal(cancelled.ok, false);
    const byOwner = resolveForumNeed({
      graph: acl,
      writer: doc.seaPubkey,
      need: open,
      now: NOW,
      hint: { principal: doc.seaPubkey, target: open.id, verb: "see", context: "emergency" },
      hop: { channel: "enrolled-station" },
    });
    assert.equal(byOwner.ok, false);
    if (!byOwner.ok) assert.equal(byOwner.reason, "offer");
    assert.equal(byOwner.elect, false);
    assert.equal(open.stated, 1);
    assert.equal(acl.ownerOf(open.id), doc.seaPubkey);
  });

  it("refuses a ham that does not rise", () => {
    const acl = createMemorySeeAcl();
    const open = need(1, 1);
    acl.putObject(open.id, doc.seaPubkey);
    const same = acceptForumNeedTransition({
      graph: acl,
      current: open,
      next: { ...open, stated: 0, hamState: 1 },
      writer: doc.seaPubkey,
      now: NOW,
    });
    assert.equal(same.ok, false);
    if (!same.ok) assert.equal(same.reason, "ham");
    assert.equal(same.elect, false);
  });

  it("freezes the body and refuses a stated flip", () => {
    const acl = createMemorySeeAcl();
    const open = need(1, 1);
    acl.putObject(open.id, doc.seaPubkey);
    const rewritten = acceptForumNeedTransition({
      graph: acl,
      current: open,
      next: { ...open, body: "rewritten", hamState: 2 },
      writer: doc.seaPubkey,
      now: NOW,
    });
    assert.equal(rewritten.ok, false);
    if (!rewritten.ok) assert.equal(rewritten.reason, "body");
    const closed = acceptForumNeedTransition({
      graph: acl,
      current: open,
      next: { ...open, stated: 0, hamState: 2 },
      writer: doc.secondPubkey,
      now: NOW,
    });
    assert.equal(closed.ok, false);
    if (!closed.ok) assert.equal(closed.reason, "stated");
    const severity = acceptForumNeedTransition({
      graph: acl,
      current: open,
      next: { ...open, severity: "need", hamState: 2 },
      writer: doc.seaPubkey,
      now: NOW,
    });
    assert.equal(severity.ok, false);
    if (!severity.ok) assert.equal(severity.reason, "severity");
    const spec = acceptForumNeedTransition({
      graph: acl,
      current: open,
      next: { ...open, spec: doc.specId, hamState: 2 },
      writer: doc.seaPubkey,
      now: NOW,
    });
    assert.equal(spec.ok, false);
    if (!spec.ok) assert.equal(spec.reason, "spec");
    assert.equal(closed.elect, false);
    assert.equal(open.stated, 1);
    assert.equal(open.body, need(1, 1).body);
  });
});

describe("forum offers", () => {
  const entropy = "ab".repeat(16);

  function grant(acl: ReturnType<typeof createMemorySeeAcl>, object: string, accessor: string) {
    acl.stateSeeGrant(doc.seaPubkey, {
      claimId: object,
      accessor,
      from: 0,
      until: NOW + 1000,
    });
  }

  it("invalid clocks cannot prepare owner offers or accept an owner-helper offer", () => {
    const acl = createMemorySeeAcl();
    const open = need(1, 1);
    acl.putObject(open.id, doc.seaPubkey);
    const offer = {
      id: mintForumOfferId(doc.seaPubkey, entropy)!, need: open.id,
      forumId: open.forumId, helper: doc.seaPubkey, body: "help",
      artifacts: "", stated: 1 as const,
    };
    const before = acl.snapshot();
    for (const now of [NaN, Infinity, -Infinity, -1, -0, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      const prepared = offerForumHelp({ graph: acl, writer: doc.seaPubkey,
        need: open, body: "help", now, entropy });
      assert.equal(prepared.ok, false);
      const accepted = acceptForumOffer({ graph: acl, writer: doc.seaPubkey,
        need: open, offer, postedOffers: new Map([[offer.id, offer]]), now });
      assert.equal(accepted.ok, false);
      assert.equal(open.stated, 1);
      assert.deepEqual(acl.snapshot(), before);
    }
  });

  it("preparing an offer preserves existing ACL ownership and grants", () => {
    const acl = createMemorySeeAcl();
    const open = need(1, 1);
    acl.putObject(open.id, doc.seaPubkey);
    grant(acl, open.id, doc.secondPubkey);
    const id = mintForumOfferId(doc.secondPubkey, entropy)!;
    // An offer payload must not replace independently held authority, even
    // when a caller supplies entropy that collides with an existing record.
    acl.putObject(id, doc.seaPubkey);
    const before = acl.snapshot();
    const offered = offerForumHelp({
      graph: acl, writer: doc.secondPubkey, need: open,
      body: "help", now: NOW, entropy,
    });
    assert.equal(offered.ok, true);
    assert.deepEqual(acl.snapshot(), before);
    assert.equal(acl.ownerOf(id), doc.seaPubkey);
    assert.equal(checkSee(acl, id, doc.secondPubkey, NOW).allowed, false);
  });

  it("posts a live offer under the need and refuses an unposted accept", () => {
    const acl = createMemorySeeAcl();
    const open = need(1, 1);
    acl.putObject(open.id, doc.seaPubkey);
    grant(acl, open.id, doc.secondPubkey);
    const wallet = offerForumHelp({
      graph: acl,
      writer: doc.linkedWallet,
      need: open,
      body: "no",
      now: NOW,
      entropy,
    });
    assert.equal(wallet.ok, false);
    if (!wallet.ok) assert.equal(wallet.reason, "writer");
    const offered = offerForumHelp({
      graph: acl,
      writer: doc.secondPubkey,
      need: open,
      body: "rollback step 3",
      now: NOW,
      entropy,
      hint: { principal: doc.secondPubkey, target: open.id, verb: "see" },
      hop: { channel: "convention-badge" },
    });
    assert.equal(offered.ok, true);
    assert.equal(offered.elect, false);
    if (!offered.ok || !offered.offer) return;
    assert.equal(offered.offer.stated, 1);
    assert.equal(offered.offer.helper, doc.secondPubkey);
    assert.equal(mintForumOfferId(doc.secondPubkey, entropy), offered.offer.id);
    assert.equal(sameEmbeddedPrincipal(doc.secondPubkey, offered.offer.id), true);
    const soul = forumOfferSoul(doc.forumId, doc.needId, offered.offer.id);
    assert.equal(soul, `s3rch/forums/${doc.forumId}/needs/${doc.needId}/offers/${offered.offer.id}`);
    assert.equal(soul.includes("/chat"), false);
    assert.equal(acl.ownerOf(offered.offer.id), undefined);
    assert.equal(acl.hasObject(offered.offer.id), false);
    assert.equal(checkSee(acl, offered.offer.id, doc.secondPubkey, NOW).allowed, false);
    assert.equal(acl.ownerOf(open.id), doc.seaPubkey);
    assert.equal(open.stated, 1);
    const posted = new Map([[offered.offer.id, offered.offer]]);
    const forged = acceptForumOffer({
      graph: acl,
      writer: doc.seaPubkey,
      need: open,
      offer: { ...offered.offer, body: "not the posted row" },
      postedOffers: posted,
      now: NOW,
    });
    assert.equal(forged.ok, false);
    if (!forged.ok) assert.equal(forged.reason, "unposted");
    const stranger = acceptForumOffer({
      graph: acl,
      writer: "not-a-party",
      need: open,
      offer: offered.offer,
      postedOffers: posted,
      now: NOW,
    });
    assert.equal(stranger.ok, false);
    if (!stranger.ok) assert.equal(stranger.reason, "party");
    const accepted = acceptForumOffer({
      graph: acl,
      writer: doc.seaPubkey,
      need: open,
      offer: offered.offer,
      postedOffers: posted,
      now: NOW,
    });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.elect, false);
    if (!accepted.ok || !accepted.need) return;
    assert.equal(accepted.need.stated, 0);
    assert.equal(accepted.need.acceptedOffer, offered.offer.id);
    assert.equal(accepted.need.body, open.body);
    assert.equal(accepted.need.severity, open.severity);
    assert.equal(accepted.need.spec, undefined);
    assert.equal(accepted.need.hamState, open.hamState + 1);
    assert.equal(accepted.owner, doc.seaPubkey);
    const stuck = withdrawForumOffer({
      graph: acl,
      writer: doc.secondPubkey,
      need: accepted.need,
      offer: offered.offer,
      postedOffers: posted,
      now: NOW,
    });
    assert.equal(stuck.ok, false);
    if (!stuck.ok) assert.equal(stuck.reason, "resolved");
  });

  it("lets the subject accept their own offer, decline, and reopen", () => {
    const acl = createMemorySeeAcl();
    const open = need(1, 1, doc.secondPubkey);
    acl.putObject(open.id, doc.seaPubkey);
    grant(acl, open.id, doc.secondPubkey);
    const offered = offerForumHelp({
      graph: acl,
      writer: doc.secondPubkey,
      need: open,
      body: "I can take this",
      now: NOW,
      entropy,
    });
    assert.equal(offered.ok, true);
    if (!offered.ok || !offered.offer) return;
    const posted = new Map([[offered.offer.id, offered.offer]]);
    acl.unstateSeeGrant(doc.seaPubkey, doc.secondPubkey, open.id);
    const blind = acceptForumOffer({
      graph: acl,
      writer: doc.secondPubkey,
      need: open,
      offer: offered.offer,
      postedOffers: posted,
      now: NOW,
    });
    assert.equal(blind.ok, false);
    if (!blind.ok) assert.equal(blind.reason, "missing-grant");
    grant(acl, open.id, doc.secondPubkey);
    const declined = declineForumOffer({
      graph: acl,
      writer: doc.seaPubkey,
      need: open,
      offer: offered.offer,
      postedOffers: posted,
      now: NOW,
    });
    assert.equal(declined.ok, true);
    if (!declined.ok || !declined.offer) return;
    assert.equal(declined.offer.stated, 0);
    assert.equal(declined.need?.stated, 1);
    assert.equal(open.stated, 1);
    posted.set(offered.offer.id, offered.offer);
    const accepted = acceptForumOffer({
      graph: acl,
      writer: doc.secondPubkey,
      need: open,
      offer: offered.offer,
      postedOffers: posted,
      now: NOW,
    });
    assert.equal(accepted.ok, true);
    if (!accepted.ok || !accepted.need) return;
    assert.equal(accepted.need.stated, 0);
    assert.equal(accepted.need.acceptedOffer, offered.offer.id);
    assert.equal(accepted.elect, false);
    assert.equal(acl.ownerOf(open.id), doc.seaPubkey);
    const subjectReopen = reopenForumNeed({
      graph: acl,
      writer: open.subject,
      need: accepted.need,
      now: NOW,
    });
    assert.equal(subjectReopen.ok, false);
    if (!subjectReopen.ok) assert.equal(subjectReopen.reason, "owner");
    const ownerReopen = reopenForumNeed({
      graph: acl,
      writer: doc.seaPubkey,
      need: accepted.need,
      now: NOW,
    });
    assert.equal(ownerReopen.ok, true);
    assert.equal(ownerReopen.elect, false);
    if (!ownerReopen.ok || !ownerReopen.need) return;
    assert.equal(ownerReopen.need.stated, 1);
    assert.equal(ownerReopen.need.acceptedOffer, undefined);
    assert.equal(ownerReopen.need.body, open.body);
    assert.equal(posted.get(offered.offer.id)?.id, offered.offer.id);
    const other = offerForumHelp({
      graph: acl,
      writer: doc.secondPubkey,
      need: ownerReopen.need,
      body: "another pass",
      now: NOW,
      entropy: "cd".repeat(16),
    });
    assert.equal(other.ok, true);
    if (!other.ok || !other.offer) return;
    posted.set(other.offer.id, other.offer);
    const pulled = withdrawForumOffer({
      graph: acl,
      writer: doc.secondPubkey,
      need: ownerReopen.need,
      offer: other.offer,
      postedOffers: posted,
      now: NOW,
    });
    assert.equal(pulled.ok, true);
    if (!pulled.ok || !pulled.offer) return;
    assert.equal(pulled.offer.stated, 0);
    assert.equal(ownerReopen.need.stated, 1);
  });
});
