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
