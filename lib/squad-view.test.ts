import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { p256 } from "@noble/curves/nist.js";
import { squadView, isPublicSquadPrincipal } from "./squad-view";
import { PILOT_AGENTS, PILOT_OWNER, PILOT_FORUM_ID, PILOT_FORUM_LABEL } from "./identity/vectors/forum-squad-fixture";
import { seaToPrincipalKey } from "./identity/forum-check";
import { checkForumSee, type SeeGraph } from "./identity/check";
import { SquadForum } from "../components/SquadForum";
const key = p256.getPublicKey(new Uint8Array(32).fill(53), false);
const owner = Buffer.from(key.slice(1, 33)).toString("base64url") + "." + Buffer.from(key.slice(33)).toString("base64url");
const live = { forumId: `forum_${seaToPrincipalKey(owner)}_${"a".repeat(32)}`, owner, label: "Isolated acceptance Squad" };

test("without live spec the product namespace stays unset, never the public fixture", () => {
  const unset = squadView();
  assert.equal(unset.live, false);
  assert.equal(unset.forumId, "");
  assert.equal(unset.key, "s3rch:squad:v2:unset");
  assert.equal(squadView(live).live, true);
  for (const principal of [PILOT_OWNER, ...PILOT_AGENTS.map(a => a.status.seaPubkey)]) {
    assert.equal(isPublicSquadPrincipal(principal), true);
    assert.throws(() => squadView({ ...live, owner: principal, forumId: `forum_${seaToPrincipalKey(principal)}_${"a".repeat(32)}` }));
  }
  assert.equal(isPublicSquadPrincipal(owner), false);
  assert.throws(() => squadView({ forumId: PILOT_FORUM_ID, owner: PILOT_OWNER, label: "Vector-owned forum" }));
  for (const invalid of [null, {}, { ...live, extra: true }, { ...live, forumId: PILOT_FORUM_ID },
    { ...live, owner: PILOT_OWNER }, { ...live, label: " " }, { ...live, label: "x".repeat(81) }])
    assert.throws(() => squadView(invalid as typeof live));
});

test("Check refuses a public vector key with no grant", () => {
  const now = 1000;
  const graph: SeeGraph = { hasObject: () => true, ownerOf: () => owner, seeGrants: () => [] };
  assert.equal(checkForumSee(graph, PILOT_FORUM_ID, PILOT_OWNER, now).allowed, false);
  assert.equal(isPublicSquadPrincipal(PILOT_OWNER), true);
});

test("namespace identity separates mount state and all persisted replay floors", () => {
  const a = squadView(live), b = squadView({ ...live, forumId: live.forumId.replace(/a{32}$/, "b".repeat(32)) }), unset = squadView();
  assert.notEqual(a.key, b.key); assert.notEqual(a.key, unset.key);
  const keys = [a, b, unset].flatMap(v => Object.values(v.storage));
  assert.equal(new Set(keys).size, 9);
  assert.ok(Object.isFrozen(a)); assert.ok(Object.isFrozen(a.storage));
});

test("public route renders no fixture roster; live component stays empty until ACL admits members", () => {
  const html = renderToStaticMarkup(createElement(SquadForum, { live }));
  assert.match(html, /Isolated acceptance Squad/);
  assert.ok(!html.includes(PILOT_FORUM_LABEL));
  for (const agent of PILOT_AGENTS) assert.ok(!html.includes(agent.status.task));
  assert.doesNotMatch(html, /Squad · preview|aria-label="Forum hierarchy"/);
  const unset = renderToStaticMarkup(createElement(SquadForum));
  assert.match(unset, /data-testid="squad-unset"/);
  assert.ok(!unset.includes(PILOT_FORUM_LABEL));
  assert.ok(!unset.includes("HAWK-2"));
  assert.doesNotMatch(unset, /aria-label="Forum hierarchy"/);
});