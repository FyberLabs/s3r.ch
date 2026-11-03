import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BusinessRoleStrips } from "../components/BusinessRoleStrips";
import { createBusinessRoles, parseBusinessTemplate } from "./forum-business-roles";
import { PILOT_FORUM_ID as forumId, PILOT_AGENTS } from "./forum-squad-fixture";
import type { ForumRoleMembership, ForumTemplate } from "./identity/forum-check";
const a = PILOT_AGENTS[0].status.seaPubkey, b = PILOT_AGENTS[1].status.seaPubkey;
function setup() {
  const admitted = new Set<object>();
  const roles = createBusinessRoles(forumId, row => admitted.has(row));
  const template = (mode: ForumTemplate["mode"]) => { const row = { forumId, mode }; admitted.add(row); roles.template(row); return row; };
  const member = (role: string, principal = a) => { const row = { forumId, role, principal }; admitted.add(row); roles.membership(row); return row; };
  return { roles, admitted, template, member };
}
test("template parser requires the exact signed forum and mode contract", () => {
  assert.deepEqual(parseBusinessTemplate({ forumId, mode: "role-labels" }, forumId), { forumId, mode: "role-labels" });
  for (const row of [null, "role-labels", { forumId, mode: "unknown" }, { forumId: "other", mode: "role-labels" },
    { forumId, mode: "role-labels", revoked: 1 }, { get forumId() { throw Error("getter"); }, mode: "role-labels" }])
    assert.equal(parseBusinessTemplate(row, forumId), null);
});
test("parsed, copied, foreign-forum and membership-only data cannot select a role", () => {
  const h = setup();
  assert.equal(h.roles.template({ forumId, mode: "role-labels" }), false);
  assert.equal(h.roles.membership({ forumId, role: "treasurer", principal: a }), false);
  h.member("treasurer"); assert.equal(h.roles.view().state, "waiting");
  h.template("role-labels"); const foreign = { forumId: "other", role: "secretary", principal: a }; h.admitted.add(foreign);
  assert.equal(h.roles.membership(foreign), false);
  assert.deepEqual(h.roles.view().members.map(r => r.role), ["treasurer"]);
});
test("distinct principals reject duplicate assignments; labels require one principal", () => {
  for (const mode of ["distinct-principals", "role-labels"] as const) {
    const h = setup(); h.template(mode); h.member("treasurer"); h.member("secretary", mode === "role-labels" ? a : b);
    assert.equal(h.roles.view().state, "ready");
    h.member("practice-manager", mode === "role-labels" ? b : a);
    assert.equal(h.roles.view().state, "conflict"); assert.deepEqual(h.roles.view().members, []);
  }
  const h = setup(); h.template("distinct-principals"); h.member("treasurer"); h.member("treasurer", b);
  assert.equal(h.roles.view().state, "conflict");
});
test("conflicting templates fail closed independent of arrival order", () => {
  for (const modes of [["role-labels", "distinct-principals"], ["distinct-principals", "role-labels"]] as const) {
    const h = setup(); modes.forEach(h.template); h.member("treasurer");
    assert.equal(h.roles.view().state, "conflict"); assert.deepEqual(h.roles.view().members, []);
  }
});
test("authority loss immediately removes members/template; reset cannot restore them", () => {
  const h = setup(), template = h.template("role-labels"), member = h.member("treasurer");
  assert.equal(h.roles.view().members.length, 1);
  h.admitted.delete(member); assert.deepEqual(h.roles.view().members, []);
  h.admitted.delete(template); assert.equal(h.roles.view().state, "waiting");
  h.admitted.add(template); h.admitted.add(member); h.roles.reset();
  assert.equal(h.roles.view().state, "waiting");
});
test("capacity does not silently omit a conflicting assignment", () => {
  const h = setup(); h.template("role-labels");
  for (let n = 0; n < 128; n++) h.member(`role-${n}`);
  assert.equal(h.roles.view().state, "ready");
  h.member("treasurer", b); assert.equal(h.roles.view().state, "capacity");
  assert.deepEqual(h.roles.view().members, []);
});
test("all role windows show empty sources and actions stay disabled even with admitted membership", () => {
  const h = setup(); h.template("role-labels");
  ["treasurer", "secretary", "practice-manager", "president"].forEach(role => h.member(role));
  const html = renderToStaticMarkup(createElement(BusinessRoleStrips, { view: h.roles.view(), roster: PILOT_AGENTS, onOpen() {} }));
  assert.equal((html.match(/<article /g) ?? []).length, 4);
  assert.equal((html.match(/disabled=""/g) ?? []).length, 4);
  assert.equal((html.match(/No verified source connected/g) ?? []).length, 4);
  assert.equal((html.match(/Open contributor/g) ?? []).length, 4);
  assert.match(html, /Resolving work does not elect/);
  assert.match(html, /Token, time and money/); assert.match(html, /Memory map and onboarding/);
  assert.match(html, /scorecards/); assert.match(html, /Roadmap/);
});
test("conflict and waiting states never render supplied principals or roster details", () => {
  for (const state of ["waiting", "conflict", "capacity"] as const) {
    const members: ForumRoleMembership[] = [{ forumId, principal: a, role: "treasurer" }];
    const html = renderToStaticMarkup(createElement(BusinessRoleStrips, { view: { state, mode: null, members }, roster: PILOT_AGENTS, onOpen() {} }));
    assert.ok(!html.includes(a)); assert.doesNotMatch(html, /Open contributor/);
    assert.equal((html.match(/disabled=""/g) ?? []).length, 4);
  }
});
