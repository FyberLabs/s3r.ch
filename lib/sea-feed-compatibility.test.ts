import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { mineOwnerChanged } from "./mine-session";
import { composePresence, fromGunPresenceNode, toGunPresenceNode, admitComposedPresence } from "./presence";
import { heldClaimOptionsFromIndicators } from "./identity/held-claims";
import { createMemorySeeAcl } from "./identity/see-acl";
import vectors from "./identity/vectors/principal.json";
const [alice, bob] = vectors.accept.map(row => row.input);
test("Mine survives disabled and unresolved observation but clears on sign-out or another owner", () => {
  assert.equal(mineOwnerChanged(alice, undefined), false);
  assert.equal(mineOwnerChanged(alice, alice), false);
  assert.equal(mineOwnerChanged(alice, null), true);
  assert.equal(mineOwnerChanged(alice, bob), true);
});
test("SEA presence composes, decodes and admits only for its owner", () => {
  const entry = composePresence({ roomId: "room", address: alice, nowSeconds: 100 });
  assert.ok(entry);
  assert.deepEqual(fromGunPresenceNode(toGunPresenceNode(entry)), entry);
  assert.ok(!("denied" in admitComposedPresence(createMemorySeeAcl(), entry, alice)));
  assert.deepEqual(admitComposedPresence(createMemorySeeAcl(), entry, bob), { denied: true });
});
test("SEA-owned user records retain identity and held claim grant options", () => {
  assert.deepEqual(heldClaimOptionsFromIndicators(alice, ["email:a@example.test"]).map(row => row.id),
    [alice, "email:a@example.test"]);
  assert.deepEqual(heldClaimOptionsFromIndicators("oidc:subject", ["email:a@example.test"]), []);
});
test("credential confirmation controls and storage retain the confirming wallet", () => {
  const source = readFileSync("components/IdentityBar.tsx", "utf8");
  assert.match(source, /useHeldConfirms\(session\?\.address \|\| null\)/);
  assert.match(source, /<HeldConfirmControls\s+address=\{session.address\}/);
});

test("SEA room-task fixture supports creation, status and assignee without granting editing", async () => {
  const { composeRoomTask, roomTasks } = await import("./room-tasks");
  const { toGunChatNode, fromGunChatNode } = await import("./chat");
  const created = composeRoomTask("room", alice, ["create", "task", "Work", "room", "open", null], 100);
  assert.ok(created);
  const status = composeRoomTask("room", alice, ["status", created.id, created.id, "doing"], 101);
  assert.ok(status);
  const assigned = composeRoomTask("room", alice, ["assign", created.id, status.id, bob], 102);
  assert.ok(assigned);
  const forged = composeRoomTask("room", bob, ["status", created.id, assigned.id, "done"], 103);
  assert.ok(forged);
  const rows = [created, status, assigned, forged].map(row => fromGunChatNode(toGunChatNode(row))!);
  assert.deepEqual(rows, [created, status, assigned, forged]);
  const [task] = roomTasks(rows, "room");
  assert.equal(task.owner, alice);
  assert.equal(task.status, "doing");
  assert.equal(task.assignee, bob);
});

test("grant recipient input names the SEA inbox and refuses wallet-only recipients", async () => {
  const { parseGrantAccessor } = await import("./identity/held-claims");
  const { grantedSoul, checksumAccessor } = await import("./grant-delivery");
  assert.equal(parseGrantAccessor(` ${bob} `), bob);
  assert.equal(checksumAccessor(bob), bob);
  assert.ok(grantedSoul(bob, "items", "post").includes(bob));
  assert.equal(parseGrantAccessor("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"), null);
});
test("identity refresh marks cached observation unresolved rather than signed out", () => {
  const source = readFileSync("components/useIdentitySession.ts", "utf8");
  assert.match(source, /setQueryData\(key, UNRESOLVED_SESSION\)/);
  assert.doesNotMatch(source, /setQueryData\(key, null\)/);
  assert.match(source, /session === UNRESOLVED_SESSION\) return query.isError \? null : undefined/);
});
