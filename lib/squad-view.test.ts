import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { p256 } from "@noble/curves/nist.js";
import { squadView, isPublicSquadPrincipal } from "./squad-view";
import { PILOT_AGENTS, PILOT_OWNER, PILOT_FORUM_ID, PILOT_FORUM_LABEL } from "./forum-squad-fixture";
import { seaToPrincipalKey } from "./identity/forum-check";
import { SquadForum } from "../components/SquadForum";
const key = p256.getPublicKey(new Uint8Array(32).fill(53), false);
const owner = Buffer.from(key.slice(1, 33)).toString("base64url") + "." + Buffer.from(key.slice(33)).toString("base64url");
const live = { forumId: `forum_${seaToPrincipalKey(owner)}_${"a".repeat(32)}`, owner, label: "Isolated acceptance Squad" };
test("default remains demo while live namespace needs a distinct owner", () => {
  assert.equal(squadView().live, false); assert.equal(squadView().forumId, PILOT_FORUM_ID);
  assert.equal(squadView(live).live, true);
  for (const principal of [PILOT_OWNER, ...PILOT_AGENTS.map(a => a.status.seaPubkey)]) {
    assert.equal(isPublicSquadPrincipal(principal), true);
    assert.throws(() => squadView({ ...live, owner: principal, forumId: `forum_${seaToPrincipalKey(principal)}_${"a".repeat(32)}` }));
  }
  assert.equal(isPublicSquadPrincipal(owner), false);
  for (const invalid of [null, {}, { ...live, extra: true }, { ...live, forumId: PILOT_FORUM_ID },
    { ...live, owner: PILOT_OWNER }, { ...live, label: " " }, { ...live, label: "x".repeat(81) }])
    assert.throws(() => squadView(invalid as typeof live));
});
test("namespace identity separates mount state and all persisted replay floors", () => {
  const a = squadView(live), b = squadView({ ...live, forumId: live.forumId.replace(/a{32}$/, "b".repeat(32)) }), demo = squadView();
  assert.notEqual(a.key, b.key); assert.notEqual(a.key, demo.key);
  const keys = [a, b, demo].flatMap(v => Object.values(v.storage));
  assert.equal(new Set(keys).size, 9);
  assert.ok(Object.isFrozen(a)); assert.ok(Object.isFrozen(a.storage));
});
test("actual live component starts empty without fixture content or authority", () => {
  const html = renderToStaticMarkup(createElement(SquadForum, { live }));
  assert.match(html, /Isolated acceptance Squad/);
  assert.ok(!html.includes(PILOT_FORUM_LABEL));
  for (const agent of PILOT_AGENTS) assert.ok(!html.includes(agent.status.task));
  assert.doesNotMatch(html, /Squad · preview/);
  const demo = renderToStaticMarkup(createElement(SquadForum));
  assert.ok(demo.includes(PILOT_FORUM_LABEL));
});
