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
  resolveForumNeed,
  sameEmbeddedPrincipal,
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

  it("lets any Check see writer resolve, including a live grant", () => {
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
    if (!stranger.ok) assert.notEqual(stranger.reason, "owner");
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
    assert.equal(byGrant.ok, true);
    assert.equal(byGrant.elect, false);
    if (byGrant.ok) {
      assert.equal(byGrant.need.stated, 0);
      assert.equal(byGrant.need.hamState, 2);
      assert.equal(byGrant.need.subject, doc.resolve.subject);
      assert.notEqual(byGrant.need.subject, doc.seaPubkey);
    }
    assert.equal(byGrant.owner, doc.seaPubkey);
    assert.equal(acl.ownerOf(open.id), doc.seaPubkey);
    const alarm = { forumId: doc.forumId, need: doc.needId, pinned: 1 };
    assert.equal(
      forumAlarmPins(alarm, { id: doc.needId, forumId: doc.forumId, severity: "emergency", stated: 0 }),
      doc.resolve.pinsResolved,
    );
  });

  it("shows a cancel on the next Check and still lets the owner resolve", () => {
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
    assert.equal(byOwner.ok, true);
    assert.equal(byOwner.elect, false);
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
});
