import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applySeeGrant,
  checkSee,
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
  authorizeForumAgentRemoval,
  authorizeForumAlarm,
  authorizeForumChat,
  authorizeForumChatTombstone,
  authorizeForumMeshRemoval,
  authorizeForumNeed,
  authorizeForumOffer,
  authorizeForumRoleAdmission,
  authorizeForumStatus,
  buildForumStatement,
  canWriteStatus,
  chatRetractionIds,
  createMeshEventVersions,
  filterAgents,
  forumStatusAdmission,
  forumOfferCancelSoul,
  mergeAgents,
  mergeForumOffer,
  needClosureStatus,
  offerBlockedByCancel,
  offerSeeWait,
  overlaySeeGraph,
  parseForumAgentRemoval,
  parseForumMeshRemoval,
  parseForumRoleMembership,
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
      entropy: "ab".repeat(16),
    });
    assert.equal(help.ok, true);
    assert.equal(help.elect, false);
    if (help.ok && help.offer) {
      assert.equal(help.offer.stated, 1);
      assert.equal(help.offer.helper, PILOT_OWNER);
      assert.equal(open.stated, 1);
    }
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

  it("hides chat only for a forum-bound tombstone on that line's key", () => {
    const line = PILOT_CHAT[0];
    assert.ok(line);
    const known = [line.id];
    assert.deepEqual(chatRetractionIds(null, line.id, known, PILOT_FORUM_ID), []);
    assert.deepEqual(chatRetractionIds(undefined, line.id, known, PILOT_FORUM_ID), []);
    assert.deepEqual(chatRetractionIds({ id: line.id, unshared: 1 }, line.id, known, PILOT_FORUM_ID), []);
    assert.deepEqual(chatRetractionIds({ id: line.id, tags: "" }, line.id, known, PILOT_FORUM_ID), []);
    const tombstone = { id: line.id, forumId: PILOT_FORUM_ID, unshared: 1 };
    assert.deepEqual(chatRetractionIds(tombstone, line.id, known, PILOT_FORUM_ID), [line.id]);
    const other = PILOT_CHAT[1];
    assert.ok(other);
    assert.deepEqual(
      chatRetractionIds(tombstone, "stmt-forged", [line.id, other.id], PILOT_FORUM_ID),
      [],
    );
    assert.deepEqual(
      chatRetractionIds(
        { id: other.id, forumId: PILOT_FORUM_ID, unshared: 1 },
        line.id,
        [line.id, other.id],
        PILOT_FORUM_ID,
      ),
      [],
    );
    assert.deepEqual(
      chatRetractionIds(
        { ...tombstone, forumId: vector.wrongForumId },
        line.id,
        known,
        PILOT_FORUM_ID,
      ),
      [],
    );
    assert.deepEqual(
      withoutChatIds([line, other], chatRetractionIds(tombstone, "stmt-forged", [line.id, other.id], PILOT_FORUM_ID)).map(
        (item) => item.id,
      ),
      [line.id, other.id],
    );
    const kept = withoutChatIds(PILOT_CHAT, [line.id]);
    assert.equal(kept.some((item) => item.id === line.id), false);
    assert.equal(kept.length, PILOT_CHAT.length - 1);
    assert.equal(
      authorizeForumChatTombstone({ signer: line.author, author: line.author, owner: PILOT_OWNER }),
      true,
    );
    assert.equal(
      authorizeForumChatTombstone({ signer: PILOT_OWNER, author: line.author, owner: PILOT_OWNER }),
      true,
    );
    const stranger = PILOT_AGENTS.find((row) => row.status.seaPubkey !== line.author);
    assert.ok(stranger);
    assert.equal(
      authorizeForumChatTombstone({
        signer: stranger.status.seaPubkey,
        author: line.author,
        owner: PILOT_OWNER,
      }),
      stranger.status.seaPubkey === PILOT_OWNER,
    );
  });

  it("drops a stale mesh read after a later event on the same key", () => {
    const versions = createMeshEventVersions();
    const first = versions.bump("chat", "stmt-1");
    const second = versions.bump("chat", "stmt-1");
    assert.equal(versions.current("chat", "stmt-1", first), false);
    assert.equal(versions.current("chat", "stmt-1", second), true);
    assert.equal(versions.current("status", "stmt-1", second), false);
    const statusGen = versions.bump("status", "stmt-1");
    assert.equal(versions.current("status", "stmt-1", statusGen), true);
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
        forumId: PILOT_FORUM_ID,
        enrolled: true,
      }),
      true,
    );
    assert.equal(
      forumStatusAdmission({
        status,
        mapKey: status.seaPubkey,
        signer: status.seaPubkey,
        forumOwner: PILOT_OWNER,
        forumId: PILOT_FORUM_ID,
        enrolled: false,
      }),
      "pending",
    );
    assert.equal(
      authorizeForumStatus({
        status,
        mapKey: status.seaPubkey,
        signer: status.seaPubkey,
        forumOwner: PILOT_OWNER,
        forumId: PILOT_FORUM_ID,
        enrolled: false,
      }),
      false,
    );
    assert.equal(
      authorizeForumStatus({
        status,
        mapKey: status.seaPubkey,
        signer: PILOT_OWNER,
        forumOwner: PILOT_OWNER,
        forumId: PILOT_FORUM_ID,
        enrolled: false,
      }),
      true,
    );
    assert.equal(
      authorizeForumStatus({
        status,
        mapKey: PILOT_OWNER,
        signer: status.seaPubkey,
        forumId: PILOT_FORUM_ID,
        enrolled: true,
      }),
      false,
    );
    assert.equal(
      authorizeForumStatus({
        status,
        mapKey: status.seaPubkey,
        signer: vector.secondPubkey === status.seaPubkey ? PILOT_OWNER : vector.secondPubkey,
        forumOwner: PILOT_OWNER,
        forumId: PILOT_FORUM_ID,
        enrolled: true,
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
        forumId: PILOT_FORUM_ID,
        enrolled: true,
      }),
      false,
    );
    assert.equal(
      authorizeForumStatus({
        status,
        mapKey: status.seaPubkey,
        signer: PILOT_OWNER,
        forumId: vector.wrongForumId,
        enrolled: true,
      }),
      false,
    );
    const removal = {
      removed: 1 as const,
      action: "remove" as const,
      forumId: PILOT_FORUM_ID,
      seaPubkey: status.seaPubkey,
      id: status.id,
    };
    assert.equal(parseForumAgentRemoval(null), null);
    assert.equal(parseForumAgentRemoval({ ...removal, removed: 0 }), null);
    assert.equal(parseForumAgentRemoval({ ...removal, action: "drop" }), null);
    assert.equal(
      forumStatusAdmission({
        status,
        mapKey: status.seaPubkey,
        signer: stranger.status.seaPubkey,
        forumOwner: PILOT_OWNER,
        forumId: PILOT_FORUM_ID,
        enrolled: false,
      }),
      "denied",
    );
    assert.equal(
      authorizeForumAgentRemoval({
        removal,
        mapKey: status.seaPubkey,
        signer: stranger.status.seaPubkey,
        forumOwner: PILOT_OWNER,
        forumId: PILOT_FORUM_ID,
      }),
      false,
    );
    assert.equal(
      authorizeForumAgentRemoval({
        removal,
        mapKey: status.seaPubkey,
        signer: status.seaPubkey,
        forumOwner: PILOT_OWNER,
        forumId: PILOT_FORUM_ID,
      }),
      true,
    );
    assert.equal(
      authorizeForumAgentRemoval({
        removal,
        mapKey: status.seaPubkey,
        signer: PILOT_OWNER,
        forumOwner: PILOT_OWNER,
        forumId: PILOT_FORUM_ID,
      }),
      true,
    );
    assert.equal(
      authorizeForumAgentRemoval({
        removal,
        mapKey: status.seaPubkey,
        signer: stranger.status.seaPubkey,
        forumOwner: PILOT_OWNER,
        forumId: PILOT_FORUM_ID,
      }),
      false,
    );
    const membership = {
      forumId: PILOT_FORUM_ID,
      role: "treasurer",
      principal: status.seaPubkey,
    };
    assert.deepEqual(parseForumRoleMembership(membership), membership);
    assert.equal(parseForumRoleMembership({ ...membership, role: "chat" }), null);
    assert.equal(
      authorizeForumRoleAdmission({
        membership,
        roleToken: "treasurer",
        mapKey: status.seaPubkey,
        signer: PILOT_OWNER,
        forumOwner: PILOT_OWNER,
        forumId: PILOT_FORUM_ID,
      }),
      true,
    );
    assert.equal(
      authorizeForumRoleAdmission({
        membership,
        roleToken: "treasurer",
        mapKey: status.seaPubkey,
        signer: status.seaPubkey,
        forumOwner: PILOT_OWNER,
        forumId: PILOT_FORUM_ID,
      }),
      false,
    );
    const outsider = {
      ...status,
      seaPubkey: "strangerpub.strangerpub",
      state: "emergency" as const,
    };
    assert.equal(
      mergeAgents(PILOT_AGENTS, [outsider]).some((row) => row.status.seaPubkey === outsider.seaPubkey),
      false,
    );
    assert.equal(
      mergeAgents(PILOT_AGENTS, [outsider], new Set([outsider.seaPubkey])).some(
        (row) => row.status.state === "emergency" && row.status.seaPubkey === outsider.seaPubkey,
      ),
      true,
    );
    const meshUpdate = { ...status, task: "from-mesh" };
    assert.equal(
      mergeAgents(PILOT_AGENTS, [meshUpdate]).find((row) => row.status.seaPubkey === status.seaPubkey)?.status.task,
      "from-mesh",
    );
  });

  it("requires the allowed signer on chat, need, alarm, and offer rows", () => {
    const line = PILOT_CHAT[0];
    const need = PILOT_NEEDS[0];
    assert.ok(line);
    assert.ok(need);
    assert.equal(authorizeForumChat(line, line.author, line.id, PILOT_FORUM_ID), true);
    assert.equal(authorizeForumChat(line, line.author, line.id, PILOT_FORUM_ID, line.author), true);
    assert.equal(authorizeForumChat(line, PILOT_OWNER, line.id, PILOT_FORUM_ID), line.author === PILOT_OWNER);
    assert.equal(
      authorizeForumChat(
        { ...line, author: PILOT_OWNER },
        PILOT_OWNER,
        line.id,
        PILOT_FORUM_ID,
        line.author,
      ),
      line.author === PILOT_OWNER,
    );
    assert.equal(authorizeForumChat(line, line.author, "stmt-other", PILOT_FORUM_ID), false);
    assert.equal(authorizeForumNeed(need, PILOT_OWNER, PILOT_OWNER, PILOT_FORUM_ID), true);
    assert.equal(authorizeForumNeed(need, vector.secondPubkey, PILOT_OWNER, PILOT_FORUM_ID), false);
    assert.equal(authorizeForumAlarm(PILOT_ALARM, PILOT_OWNER, PILOT_OWNER, PILOT_FORUM_ID), true);
    assert.equal(authorizeForumAlarm(PILOT_ALARM, vector.secondPubkey, PILOT_OWNER, PILOT_FORUM_ID), false);
    const helperAgent = PILOT_AGENTS.find((row) => row.status.seaPubkey !== PILOT_OWNER);
    assert.ok(helperAgent);
    const helper = helperAgent.status.seaPubkey;
    const offer = {
      id: "offer-local",
      need: need.id,
      forumId: PILOT_FORUM_ID,
      helper,
      body: "holding",
      artifacts: "",
      stated: 1 as const,
    };
    const openGraph = createMemorySeeAcl();
    openGraph.putObject(need.id, PILOT_OWNER);
    applySeeGrant(openGraph, PILOT_OWNER, {
      claimId: need.id,
      accessor: helper,
      from: 0,
      until: 10_000_000_000,
    });
    const seen = { graph: openGraph, need, now: 1_000 };
    assert.equal(authorizeForumOffer(offer, helper, PILOT_FORUM_ID), false);
    assert.equal(authorizeForumOffer(offer, helper, PILOT_FORUM_ID, undefined, seen), true);
    assert.equal(authorizeForumOffer(offer, PILOT_OWNER, PILOT_FORUM_ID, undefined, seen), false);
    const withdrawn = { ...offer, stated: 0 as const };
    assert.equal(authorizeForumOffer(withdrawn, helper, PILOT_FORUM_ID), true);
    const live = {
      ...offer,
      id: `offer_${seaToPrincipalKey(helper)}_${"ef".repeat(16)}`,
      helper,
      body: "holding west",
    };
    assert.equal(mergeForumOffer(undefined, live)?.stated, 1);
    assert.equal(mergeForumOffer(live, { ...live, stated: 0 })?.stated, 0);
    assert.equal(mergeForumOffer({ ...live, stated: 0 }, live), null);
    assert.equal(offerBlockedByCancel(new Set([live.id]), live), true);
    assert.equal(offerBlockedByCancel(new Set(), live), false);
    assert.equal(forumOfferCancelSoul(PILOT_FORUM_ID, need.id, live.id).endsWith("/cancel"), true);
    const openGraphWait = createMemorySeeAcl();
    assert.equal(
      offerSeeWait({ offer: live, graph: openGraphWait, need, now: 1_000 }),
      true,
    );
    openGraphWait.putObject(need.id, PILOT_OWNER);
    applySeeGrant(openGraphWait, PILOT_OWNER, {
      claimId: need.id,
      accessor: helper,
      from: 0,
      until: 10_000_000_000,
    });
    assert.equal(offerSeeWait({ offer: live, graph: openGraphWait, need, now: 1_000 }), false);
    const withdrawnAfter = { ...live, stated: 0 as const };
    assert.equal(
      authorizeForumOffer(withdrawnAfter, helper, PILOT_FORUM_ID, undefined, {
        graph: openGraph,
        need: { ...need, stated: 0, acceptedOffer: live.id },
        now: 1_000,
      }),
      false,
    );
  });

  it("keeps the admitted sample owner when a mesh edge names another pubkey", () => {
    const need = PILOT_NEEDS.find((row) => row.stated === 1 && row.subject !== PILOT_OWNER);
    assert.ok(need);
    const sample = createMemorySeeAcl();
    admitPilotRoster(sample);
    const primary = createMemorySeeAcl();
    primary.putObject(need.id, need.subject);
    applySeeGrant(primary, need.subject, {
      claimId: need.id,
      accessor: need.subject,
      from: 0,
      until: 10_000_000_000,
    });
    const graph = overlaySeeGraph(primary, sample);
    assert.equal(graph.ownerOf(need.id), PILOT_OWNER);
    assert.equal(checkSee(graph, need.id, need.subject, 1_000).allowed, false);
    assert.equal(checkSee(graph, need.id, PILOT_OWNER, 1_000).reason, "owner");
    assert.equal(graph.ownerOf("not-a-sample-object"), undefined);
    primary.putObject("not-a-sample-object", need.subject);
    assert.equal(overlaySeeGraph(primary, sample).ownerOf("not-a-sample-object"), need.subject);
  });

  it("closes a mesh need only when the accepted offer is live and the helper can see", () => {
    const need = PILOT_NEEDS.find((row) => row.stated === 1 && row.subject !== PILOT_OWNER);
    assert.ok(need);
    const helperKey = seaToPrincipalKey(need.subject);
    assert.ok(helperKey);
    const offerId = `offer_${helperKey}_${"cd".repeat(16)}`;
    const offer = {
      id: offerId,
      need: need.id,
      forumId: PILOT_FORUM_ID,
      helper: need.subject,
      body: "holding",
      artifacts: "",
      stated: 1 as const,
    };
    const closed = {
      ...need,
      stated: 0 as const,
      acceptedOffer: offerId,
      hamState: need.hamState + 1,
    };
    const graph = createMemorySeeAcl();
    graph.putObject(need.id, PILOT_OWNER);
    const now = 1_000;
    const bare = { graph, postedOffers: new Map([[offer.id, offer]]), now };
    assert.equal(
      authorizeForumNeed(closed, need.subject, PILOT_OWNER, PILOT_FORUM_ID, need, bare),
      false,
    );
    applySeeGrant(graph, PILOT_OWNER, {
      claimId: need.id,
      accessor: need.subject,
      from: 0,
      until: 10_000_000_000,
    });
    assert.equal(
      authorizeForumNeed(closed, need.subject, PILOT_OWNER, PILOT_FORUM_ID, need, {
        graph,
        postedOffers: new Map(),
        now,
      }),
      false,
    );
    assert.equal(
      authorizeForumNeed(closed, need.subject, PILOT_OWNER, PILOT_FORUM_ID, need, bare),
      true,
    );
    assert.equal(
      authorizeForumNeed(closed, PILOT_OWNER, PILOT_OWNER, PILOT_FORUM_ID, need, bare),
      true,
    );
    const stranger = PILOT_AGENTS.find(
      (row) => row.status.seaPubkey !== PILOT_OWNER && row.status.seaPubkey !== need.subject,
    );
    assert.ok(stranger);
    assert.equal(
      authorizeForumNeed(closed, stranger.status.seaPubkey, PILOT_OWNER, PILOT_FORUM_ID, need, bare),
      false,
    );
    assert.equal(authorizeForumNeed(closed, need.subject, PILOT_OWNER, PILOT_FORUM_ID, undefined, bare), true);
    assert.equal(
      authorizeForumNeed(closed, need.subject, PILOT_OWNER, PILOT_FORUM_ID, undefined, {
        graph,
        postedOffers: new Map(),
        now,
      }),
      false,
    );
    assert.equal(
      needClosureStatus(closed, { graph, postedOffers: new Map(), now }),
      "wait",
    );
    const removal = {
      removed: 1 as const,
      action: "remove" as const,
      forumId: PILOT_FORUM_ID,
      id: need.id,
      kind: "need" as const,
    };
    assert.equal(parseForumMeshRemoval(null), null);
    assert.equal(parseForumMeshRemoval({ id: need.id, unshared: 1 }), null);
    assert.equal(
      authorizeForumMeshRemoval({
        removal,
        mapKey: need.id,
        signer: PILOT_OWNER,
        owner: PILOT_OWNER,
        subject: need.subject,
        forumId: PILOT_FORUM_ID,
      }),
      true,
    );
    assert.equal(
      authorizeForumMeshRemoval({
        removal,
        mapKey: need.id,
        signer: "not-the-owner.not-the-owner",
        owner: PILOT_OWNER,
        subject: need.subject,
        forumId: PILOT_FORUM_ID,
      }),
      false,
    );
    const offerRemoval = {
      removed: 1 as const,
      action: "remove" as const,
      forumId: PILOT_FORUM_ID,
      id: offerId,
      kind: "offer" as const,
      need: need.id,
    };
    assert.equal(
      authorizeForumMeshRemoval({
        removal: offerRemoval,
        mapKey: offerId,
        signer: need.subject,
        owner: PILOT_OWNER,
        subject: need.subject,
        forumId: PILOT_FORUM_ID,
        parentNeedId: need.id,
        resolved: true,
      }),
      false,
    );
    assert.equal(
      authorizeForumMeshRemoval({
        removal: offerRemoval,
        mapKey: offerId,
        signer: PILOT_OWNER,
        owner: PILOT_OWNER,
        subject: need.subject,
        forumId: PILOT_FORUM_ID,
        parentNeedId: need.id,
        resolved: true,
      }),
      true,
    );
    assert.equal(
      authorizeForumMeshRemoval({
        removal: offerRemoval,
        mapKey: offerId,
        signer: need.subject,
        owner: PILOT_OWNER,
        subject: need.subject,
        forumId: PILOT_FORUM_ID,
        parentNeedId: need.id,
      }),
      true,
    );
    assert.equal(
      authorizeForumMeshRemoval({
        removal: offerRemoval,
        mapKey: "offer-other",
        signer: need.subject,
        owner: PILOT_OWNER,
        subject: need.subject,
        forumId: PILOT_FORUM_ID,
        parentNeedId: need.id,
      }),
      false,
    );
  });

  it("keeps the sample status soul on the contract path", () => {
    const hawk = PILOT_AGENTS[0];
    assert.ok(hawk);
    assert.equal(hawk.status.id, vector.statusId);
    assert.equal(forumAgentSoul(PILOT_FORUM_ID, hawk.status.seaPubkey), vector.souls.agent);
    assert.equal(PILOT_AGENTS.length, 12);
  });
});
