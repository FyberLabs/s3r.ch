import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { p256 } from "@noble/curves/nist.js";
import { squadView } from "./squad-view";
import { PILOT_AGENTS, PILOT_FORUM_LABEL } from "./identity/vectors/forum-squad-fixture";
import { seaToPrincipalKey } from "./identity/forum-check";
import { SquadForum } from "../components/SquadForum";
const key = p256.getPublicKey(new Uint8Array(32).fill(53), false);
const owner = Buffer.from(key.slice(1, 33)).toString("base64url") + "." + Buffer.from(key.slice(33)).toString("base64url");
const live = { forumId: `forum_${seaToPrincipalKey(owner)}_${"a".repeat(32)}`, owner, label: "Isolated acceptance Squad" };

test("without live spec the product namespace stays unset", () => {
  const unset = squadView();
  assert.equal(unset.live, false);
  assert.equal(unset.forumId, "");
  assert.equal(unset.key, "s3rch:squad:v2:unset");
  assert.equal(squadView(live).live, true);
  for (const invalid of [null, {}, { ...live, extra: true }, { ...live, label: " " }, { ...live, label: "x".repeat(81) }])
    assert.throws(() => squadView(invalid as typeof live));
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
  assert.match(unset, /have a squad yet/);
});