import assert from "node:assert/strict";
import test from "node:test";
import { createStartupLinkedLogin, resolveStartupLinkedIdentity, type StartupLoginBinding } from "./startup-linked-login";
import type { SeaPair } from "./sea";
import vector from "./vectors/forums.json";
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const expected = (): StartupLoginBinding => ({ binding_sha256: "a".repeat(64), mapping_sha256: "b".repeat(64),
  sea_public_key: vector.seaPubkey, tenant_id: id(1), network_id: "isolated",
  entra: { tenant_id: id(2), object_id: id(3) },
  organizations: ["fyberlabs", "hyperme.sh", "tennesseewindage"].map((slug, index) =>
    ({ slug, id: id(10 + index), tenant_id: id(1), roles: ["admin", "owner"] })),
});
const response = () => ({ ...expected(), schema_version: 1, status: "resolved", permissions: [],
  person_id: id(4), broker_subject: "opaque-broker-person" });
const pair = (): SeaPair => ({ pub: vector.seaPubkey, priv: "unit-only", epub: "unit-only", epriv: "unit-only" });
const subject = "opaque-broker-person";
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }

test("exact authenticated account preserves the SEA key and explicit memberships", () => {
  const value = response();
  const result = resolveStartupLinkedIdentity(value, expected(), subject, { sea_public_key: vector.seaPubkey });
  assert.ok(result);
  assert.equal(result.sea_public_key, vector.seaPubkey);
  assert.equal(result.person_id, id(4));
  assert.deepEqual(result.organizations, expected().organizations);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.organizations) && Object.isFrozen(result.organizations[0].roles));
  (value.organizations[0] as { roles: readonly string[] }).roles = ["owner"];
  assert.deepEqual(result.organizations[0].roles, ["admin", "owner"]);
  // Additive peer fields may be ignored; they never become identity or grants.
  assert.ok(resolveStartupLinkedIdentity({ ...response(), future_field: true }, expected(), subject, { sea_public_key: vector.seaPubkey }));
});

test("matching email never repairs a different immutable account, binding or organization", () => {
  const variants = [
    { ...response(), entra: { ...expected().entra, object_id: id(99) } },
    { ...response(), entra: { ...expected().entra, tenant_id: id(99) } },
    { ...response(), binding_sha256: "c".repeat(64) }, { ...response(), mapping_sha256: "c".repeat(64) },
    { ...response(), broker_subject: "other" }, { ...response(), tenant_id: id(99) },
    { ...response(), network_id: "other" }, { ...response(), sea_public_key: "missing" },
    { ...response(), organizations: response().organizations.map((row, i) => i ? row : { ...row, id: id(99) }) },
    { ...response(), organizations: response().organizations.map((row, i) => i ? row : { ...row, tenant_id: id(99) }) },
    { ...response(), organizations: response().organizations.map((row, i) => i ? row : { ...row, roles: ["owner"] }) },
  ];
  for (const value of variants) assert.equal(resolveStartupLinkedIdentity({ ...value, email: "same@example.invalid" },
    expected(), subject, { sea_public_key: vector.seaPubkey }), null);
  assert.equal(resolveStartupLinkedIdentity(response(), expected(), subject, { sea_public_key: "missing" }), null);
  assert.equal(resolveStartupLinkedIdentity(response(), expected(), subject, { sea_public_key: vector.seaPubkey, person_id: id(99) }), null);
});

test("malformed, incomplete and privilege-bearing responses refuse", () => {
  const variants: unknown[] = [null, [], {}, { ...response(), schema_version: true }, { ...response(), status: "pending" },
    { ...response(), permissions: ["admin"] }, { ...response(), permissions: null }, { ...response(), person_id: "email@example.invalid" },
    { ...response(), entra: null }, { ...response(), organizations: [] }, { ...response(), network_id: "" },
    { ...response(), organizations: [...response().organizations].reverse() },
  ];
  for (const roles of [[], ["admin", "admin"], ["owner", "admin"], ["member"], "owner", [true]]) {
    variants.push({ ...response(), organizations: response().organizations.map((row, i) => i ? row : { ...row, roles }) });
  }
  variants.push({ ...response(), organizations: response().organizations.map(row => ({ ...row, id: id(10) })) });
  for (const value of variants) assert.equal(resolveStartupLinkedIdentity(value, expected(), subject, { sea_public_key: vector.seaPubkey }), null);
  assert.equal(resolveStartupLinkedIdentity(response(), expected(), "bad\n", { sea_public_key: vector.seaPubkey }), null);
});

test("login/relogin keeps the existing key and person without a provisioning capability", async () => {
  const key = pair(); let rev = 0, value = response();
  const controller = createStartupLinkedLogin({ expected: expected(), currentKey: () => key, keyRevision: () => rev,
    lookup: async () => ({ identity: value, verifiedSubject: subject }) });
  assert.equal((await controller.login())?.sea_public_key, key.pub);
  controller.logout(); assert.equal(controller.current(), null);
  assert.equal((await controller.login())?.person_id, id(4));
  value = { ...response(), person_id: id(99) };
  assert.equal(await controller.login(), null);
  assert.equal(controller.current(), null);
  value = response(); assert.ok(await controller.login());
  rev++; assert.equal(controller.current(), null);
  assert.equal(key.pub, vector.seaPubkey);
});

test("missing, locked or conflicting key refuses before owner lookup", async () => {
  for (const key of [null, { ...pair(), pub: "other" }, { ...pair(), priv: "" }]) {
    const controller = createStartupLinkedLogin({ expected: expected(), currentKey: () => key, keyRevision: () => 0,
      lookup: async () => { assert.fail("must not fetch"); } });
    assert.equal(await controller.login(), null);
  }
});

test("logout and transient lock fence a pending lookup even when the same key returns", async () => {
  for (const action of ["logout", "lock", "replace"]) {
    const pending = deferred<{ identity: unknown; verifiedSubject: string }>(); let key = pair(), rev = 0;
    const controller = createStartupLinkedLogin({ expected: expected(), currentKey: () => key, keyRevision: () => rev,
      lookup: () => pending.promise });
    const result = controller.login();
    if (action === "logout") controller.logout();
    if (action === "lock") rev += 2;
    if (action === "replace") key = pair();
    pending.resolve({ identity: response(), verifiedSubject: subject });
    assert.equal(await result, null); assert.equal(controller.current(), null);
  }
});

test("a newer login wins and configuration mutation cannot retarget pending work", async () => {
  const key = pair(), config = expected();
  const pending = deferred<{ identity: unknown; verifiedSubject: string }>(); let count = 0;
  const controller = createStartupLinkedLogin({ expected: config, currentKey: () => key, keyRevision: () => 0,
    lookup: () => ++count === 1 ? pending.promise : Promise.resolve({ identity: response(), verifiedSubject: subject }) });
  const older = controller.login();
  (config.organizations[0] as { id: string }).id = id(99);
  const newer = await controller.login(); assert.ok(newer);
  pending.resolve({ identity: response(), verifiedSubject: subject });
  assert.equal(await older, null); assert.equal(controller.current(), newer);
});

test("unavailable owner and malformed trusted configuration deny", async () => {
  const key = pair();
  for (const config of [expected(), { ...expected(), binding_sha256: "invalid" }]) {
    const controller = createStartupLinkedLogin({ expected: config, currentKey: () => key, keyRevision: () => 0,
      lookup: async () => { throw Error("unavailable"); } });
    assert.equal(await controller.login(), null); assert.equal(controller.current(), null);
  }
});
