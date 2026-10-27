import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  forumAgentSoul,
  forumChatTag,
  forumOfferSoul,
  isSeparateChatSoul,
  offerForumHelp,
  resolveForumNeed,
  seaToPrincipalKey,
} from "@/lib/identity/check";
import { createMemorySeeAcl } from "@/lib/identity/see-acl";
import vector from "@/lib/identity/vectors/forums.json";
import {
  authorizeForumAlarm,
  authorizeForumChat,
  authorizeForumNeed,
  authorizeForumOffer,
  authorizeForumStatus,
  buildForumStatement,
  canWriteStatus,
  chatRetractionIds,
  filterAgents,
  pickDisplayedStatus,
  showFullVitals,
  sortAgents,
  withoutChatIds,
  type SquadAgent,
} from "@/lib/forum-squad";
import {
  PILOT_AGENTS,
  PILOT_ALARM,
  PILOT_CHAT,
  PILOT_FORUM_ID,
  PILOT_NEEDS,
  PILOT_OWNER,
  admitPilotRoster,
} from "@/lib/forum-squad-fixture";

function agent(label: string, state: SquadAgent["status"]["state"]): SquadAgent {
  const base = PILOT_AGENTS[0];
  if (!base) throw new Error("empty roster");
  return {
    ...base,
    label,
    status: { ...base.status, state, seaPubkey: `${label}.not-used` },
  };
}

describe("squad view", () => {
  it("sorts by severity and keeps the earlier tile when states match", () => {
    const idle = agent("idle", "idle");
    const working = agent("working", "working");
    const needs = agent("needs", "needs");
    const emergency = agent("emergency", "emergency");
    const sorted = sortAgents([idle, working, needs, emergency, { ...working, label: "working-2" }]);
    assert.deepEqual(
      sorted.map((row) => row.label),
      ["emergency", "needs", "working", "working-2", "idle"],
    );
  });

  it("filters by state and query", () => {
    const rows = filterAgents(PILOT_AGENTS, new Set(["emergency"]), "");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.label, "HAWK-2");
    const rover = filterAgents(PILOT_AGENTS, new Set(), "waypoint");
    assert.equal(rover.length, 1);
    assert.equal(rover[0]?.label, "ROVER-1");
  });

  it("shows full vitals for a robot only in auto", () => {
    assert.equal(showFullVitals("agent", "auto"), false);
    assert.equal(showFullVitals("robot", "auto"), true);
    assert.equal(showFullVitals("robotics", "auto"), true);
    assert.equal(showFullVitals("robot", "dot"), false);
    assert.equal(showFullVitals("agent", "full"), true);
  });

  it("builds a tagged item and refuses a wallet author", () => {
    const item = buildForumStatement({
      forumId: PILOT_FORUM_ID,
      author: PILOT_OWNER,
      body: "holding",
      now: 1_762_000_100,
      entropy: "ab12",
    });
    assert.ok(item);
    assert.equal(item?.author, PILOT_OWNER);
    assert.equal(item?.tags[0], forumChatTag(PILOT_FORUM_ID));
    assert.equal(isSeparateChatSoul(`s3rch/items/${item?.id}`), false);
    assert.equal(
      buildForumStatement({
        forumId: PILOT_FORUM_ID,
        author: vector.linkedWallet,
        body: "no",
        now: 1,
        entropy: "ab",
      }),
      null,
    );
  });

  it("allows a status write only for the admitted SEA owner", () => {
    assert.equal(canWriteStatus(PILOT_OWNER, PILOT_OWNER), true);
    assert.equal(canWriteStatus(PILOT_OWNER, vector.secondPubkey), false);
    assert.equal(canWriteStatus(PILOT_OWNER, vector.linkedWallet), false);
    assert.equal(canWriteStatus(undefined, PILOT_OWNER), false);
  });

  it("does not close the sample need from Check see", () => {
    const acl = createMemorySeeAcl();
    admitPilotRoster(acl);
    const need = PILOT_AGENTS[0];
    assert.ok(need);
    const open = {
      id: need.status.needs,
      forumId: PILOT_FORUM_ID,
      subject: PILOT_OWNER,
      severity: "emergency" as const,
      body: "human ack + rollback auth",
      stated: 1 as const,
      hamState: 1,
      ts: 1_762_000_000,
    };
    const denied = resolveForumNeed({
      graph: acl,
      writer: vector.secondPubkey,
      need: open,
      now: 1_762_000_100,
    });
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.reason, "missing-grant");
    assert.equal(denied.elect, false);
    const owner = resolveForumNeed({
      graph: acl,
      writer: PILOT_OWNER,
      need: open,
      now: 1_762_000_100,
    });
    assert.equal(owner.ok, false);
    if (!owner.ok) assert.equal(owner.reason, "offer");
    assert.equal(owner.elect, false);
    assert.equal(open.stated, 1);
    const help = offerForumHelp({
      graph: acl,
      writer: PILOT_OWNER,
      need: open,
      body: "holding the rollback",
      now: 1_762_000_100,
    });
    assert.equal(help.ok, false);
    if (!help.ok) assert.equal(help.reason, "unshipped");
    assert.equal(help.elect, false);
    const helperKey = seaToPrincipalKey(vector.secondPubkey);
    assert.ok(helperKey);
    const offerId = `offer_${helperKey}_${"ab".repeat(16)}`;
    const soul = forumOfferSoul(PILOT_FORUM_ID, open.id, offerId);
    assert.equal(soul, `s3rch/forums/${PILOT_FORUM_ID}/needs/${open.id}/offers/${offerId}`);
    assert.equal(acl.ownerOf(open.id), PILOT_OWNER);
  });

  it("retires a local pause when the mesh lastUpdate is equal or newer", () => {
    const base = PILOT_AGENTS[1]?.status;
    assert.ok(base);
    const paused = { ...base, state: "idle" as const, lastUpdate: base.lastUpdate + 10 };
    const emergency = { ...base, state: "emergency" as const, lastUpdate: base.lastUpdate + 20 };
    assert.equal(pickDisplayedStatus(base, undefined).state, base.state);
    assert.equal(pickDisplayedStatus(base, paused).state, "idle");
    assert.equal(pickDisplayedStatus(emergency, paused).state, "emergency");
    assert.equal(pickDisplayedStatus(paused, paused).lastUpdate, paused.lastUpdate);
    assert.equal(pickDisplayedStatus(paused, paused), paused);
    const echoed = { ...paused };
    assert.equal(pickDisplayedStatus(echoed, paused), echoed);
  });

  it("drops retracted chat and leaves unrelated feed rows alone", () => {
    const line = PILOT_CHAT[0];
    assert.ok(line);
    assert.deepEqual(chatRetractionIds(null, line.id, [line.id]), [line.id]);
    assert.deepEqual(chatRetractionIds(undefined, line.id, [line.id]), []);
    assert.deepEqual(chatRetractionIds({ id: line.id, unshared: 1 }, line.id, [line.id]), [line.id]);
    assert.deepEqual(chatRetractionIds({ id: line.id, tags: "" }, line.id, [line.id]), [line.id]);
    assert.deepEqual(chatRetractionIds({ id: line.id, tags: "" }, "stmt-forged", [line.id]), []);
    assert.deepEqual(
      chatRetractionIds({ id: "stmt-other", body: "public" }, "stmt-other", [line.id]),
      [],
    );
    const kept = withoutChatIds(PILOT_CHAT, [line.id]);
    assert.equal(kept.some((item) => item.id === line.id), false);
    assert.equal(kept.length, PILOT_CHAT.length - 1);
  });

  it("accepts a status row only from the agent pubkey or the admitted owner", () => {
    const agent = PILOT_AGENTS.find((row) => row.status.seaPubkey !== PILOT_OWNER);
    assert.ok(agent);
    const status = agent.status;
    assert.equal(
      authorizeForumStatus({
        status,
        mapKey: status.seaPubkey,
        signer: status.seaPubkey,
        owner: PILOT_OWNER,
        forumId: PILOT_FORUM_ID,
      }),
      true,
    );
    assert.equal(
      authorizeForumStatus({
        status,
        mapKey: status.seaPubkey,
        signer: PILOT_OWNER,
        owner: PILOT_OWNER,
        forumId: PILOT_FORUM_ID,
      }),
      true,
    );
    assert.equal(
      authorizeForumStatus({
        status,
        mapKey: PILOT_OWNER,
        signer: status.seaPubkey,
        owner: PILOT_OWNER,
        forumId: PILOT_FORUM_ID,
      }),
      false,
    );
    assert.equal(
      authorizeForumStatus({
        status,
        mapKey: status.seaPubkey,
        signer: vector.secondPubkey === status.seaPubkey ? PILOT_OWNER : vector.secondPubkey,
        owner: PILOT_OWNER,
        forumId: PILOT_FORUM_ID,
      }),
      vector.secondPubkey === status.seaPubkey,
    );
    const stranger = PILOT_AGENTS.find(
      (row) => row.status.seaPubkey !== status.seaPubkey && row.status.seaPubkey !== PILOT_OWNER,
    );
    assert.ok(stranger);
    assert.equal(
      authorizeForumStatus({
        status,
        mapKey: status.seaPubkey,
        signer: stranger.status.seaPubkey,
        owner: PILOT_OWNER,
        forumId: PILOT_FORUM_ID,
      }),
      false,
    );
    assert.equal(
      authorizeForumStatus({
        status,
        mapKey: status.seaPubkey,
        signer: PILOT_OWNER,
        owner: PILOT_OWNER,
        forumId: vector.wrongForumId,
      }),
      false,
    );
  });

  it("requires the allowed signer on chat, need, alarm, and offer rows", () => {
    const line = PILOT_CHAT[0];
    const need = PILOT_NEEDS[0];
    assert.ok(line);
    assert.ok(need);
    assert.equal(authorizeForumChat(line, line.author, line.id, PILOT_FORUM_ID), true);
    assert.equal(authorizeForumChat(line, PILOT_OWNER, line.id, PILOT_FORUM_ID), line.author === PILOT_OWNER);
    assert.equal(authorizeForumChat(line, line.author, "stmt-other", PILOT_FORUM_ID), false);
    assert.equal(authorizeForumNeed(need, PILOT_OWNER, PILOT_OWNER, PILOT_FORUM_ID), true);
    assert.equal(authorizeForumNeed(need, vector.secondPubkey, PILOT_OWNER, PILOT_FORUM_ID), false);
    assert.equal(authorizeForumAlarm(PILOT_ALARM, PILOT_OWNER, PILOT_OWNER, PILOT_FORUM_ID), true);
    assert.equal(authorizeForumAlarm(PILOT_ALARM, vector.secondPubkey, PILOT_OWNER, PILOT_FORUM_ID), false);
    const offer = {
      id: "offer-local",
      need: need.id,
      forumId: PILOT_FORUM_ID,
      helper: vector.secondPubkey,
      body: "holding",
      artifacts: "",
      stated: 1 as const,
    };
    assert.equal(authorizeForumOffer(offer, vector.secondPubkey, PILOT_FORUM_ID), true);
    assert.equal(authorizeForumOffer(offer, PILOT_OWNER, PILOT_FORUM_ID), false);
  });

  it("keeps the sample status soul on the contract path", () => {
    const hawk = PILOT_AGENTS[0];
    assert.ok(hawk);
    assert.equal(hawk.status.id, vector.statusId);
    assert.equal(forumAgentSoul(PILOT_FORUM_ID, hawk.status.seaPubkey), vector.souls.agent);
    assert.equal(PILOT_AGENTS.length, 12);
  });
});
