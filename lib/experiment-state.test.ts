import test, { before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { SignJWT, jwtVerify } from "jose";
import { createExperimentState, anonymousExperimentCookie, experimentStateCookie } from "./experiment-state";
import { experimentKeyVersionsCookie, experimentKeyVersion } from "./experiment-key-versions";
import { hashExperimentAssignment } from "./experiment-contract";
const sea = createRequire(import.meta.url)("gun/sea");
let firstPrincipal: string, secondPrincipal: string;
before(async () => { firstPrincipal = (await sea.pair()).pub; secondPrincipal = (await sea.pair()).pub; });
const secret = new Uint8Array(32).fill(97);
const experiments = [{ key: "layout", control: "control", variants: ["control", "treatment"] }, { key: "next", control: "control", variants: ["control", "treatment"] }];
const header = (values: readonly string[]) => values.map(value => value.split(";")[0]).join("; ");
const choose = async () => "treatment";

test("anonymous cookies are host-only and retain assignments across server instances", async () => {
  const first = await createExperimentState({ secret, clock: () => 100 })("", null, experiments);
  const assigned = await first.evaluate("layout", choose), cookies = await first.cookies();
  assert.match(cookies[0], /^__Host-s3rch-experiment-id=[0-9a-f-]{36}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=31536000$/);
  assert.ok(cookies.every(value => !value.includes("Domain=")));
  const other = await createExperimentState({ secret, clock: () => 101 })(header(cookies), null, experiments);
  assert.deepEqual(await other.evaluate("layout", async () => { throw Error("must retain"); }), assigned);
});

test("sign-in preserves the anonymous cohort and uses the verified stable key for new experiments", async () => {
  const open = createExperimentState({ secret, clock: () => 100 });
  const anonymous = await open("", null, experiments), before = await anonymous.evaluate("layout", choose);
  const signedIn = await open(header(await anonymous.cookies()), firstPrincipal, experiments);
  assert.deepEqual(await signedIn.evaluate("layout", async () => "control"), before);
  let target = "";
  const next = await signedIn.evaluate("next", async key => { target = key; return "treatment"; });
  assert.equal(target, hashExperimentAssignment(firstPrincipal, secret));
  assert.equal(next.assignment_hash, target);
  assert.ok(!(await signedIn.cookies()).join().includes(firstPrincipal));
  const persisted = await open(header(await signedIn.cookies()), firstPrincipal, experiments);
  assert.deepEqual(await persisted.evaluate("layout", choose), before);
});

test("logout and account switches clear the prior user's assignments", async () => {
  const open = createExperimentState({ secret, clock: () => 100 });
  const first = await open("", firstPrincipal, experiments); await first.evaluate("layout", choose);
  const cookies = header(await first.cookies());
  for (const principal of [null, secondPrincipal]) {
    const next = await open(cookies, principal, experiments);
    const assigned = await next.evaluate("layout", async () => "control");
    assert.equal(assigned.variant, "control");
    assert.notEqual(assigned.assignment_hash, hashExperimentAssignment(firstPrincipal, secret));
  }
});

test("provider absence defaults to control without fixing a false cohort; guardrails override retained variants", async () => {
  const state = await createExperimentState({ secret })("", null, experiments);
  assert.equal((await state.evaluate("layout", async () => { throw Error("offline"); })).variant, "control");
  assert.equal((await state.evaluate("layout", async () => "unknown")).variant, "control");
  assert.equal((await state.evaluate("layout", choose, false)).variant, "control");
  const assigned = await state.evaluate("layout", choose);
  assert.equal(assigned.variant, "treatment");
  assert.equal((await state.evaluate("layout", choose, false)).variant, "control");
  assert.deepEqual(await state.evaluate("layout", choose), assigned);
  await assert.rejects(() => state.evaluate("inactive", choose));
});

test("tampered, duplicated, oversized, expired and wrong-secret state cannot retain variants", async () => {
  const first = await createExperimentState({ secret, clock: () => 100 })("", null, experiments);
  await first.evaluate("layout", choose);
  const cookies = await first.cookies(), original = header(cookies);
  const bad = [original.replace(/(s3rch-experiments=)./, "$1x"), `${original}; ${cookies[1].split(";")[0]}`,
    `${anonymousExperimentCookie}=bad; ${cookies[1].split(";")[0]}`, `${experimentStateCookie}=${"x".repeat(4000)}`, "x".repeat(16385)];
  for (const value of bad) {
    const state = await createExperimentState({ secret, clock: () => 101 })(value, null, experiments);
    assert.equal((await state.evaluate("layout", async () => "control")).variant, "control");
  }
  for (const options of [{ secret, clock: () => 31536101 }, { secret: new Uint8Array(32).fill(98), clock: () => 101 }]) {
    const state = await createExperimentState(options)(original, null, experiments);
    assert.equal((await state.evaluate("layout", async () => "control")).variant, "control");
  }
});

test("signed malformed state and invalid configuration fail safely", async () => {
  const anon = "12345678-1234-4234-8234-123456789abc";
  for (const state of [null, {}, { anonymous: anon, subject: null, assignments: [{ key: "layout", variant: "treatment", hash: "bad" }] }]) {
    const token = await new SignJWT({ state }).setProtectedHeader({ alg: "HS256", typ: "s3rch-experiment-state-v1" }).setIssuer("s3rch").setAudience("s3rch-experiment-state-v1").setIssuedAt(100).setExpirationTime(31536100).sign(secret);
    const result = await createExperimentState({ secret, clock: () => 101 })(`${anonymousExperimentCookie}=${anon}; ${experimentStateCookie}=${token}`, null, experiments);
    assert.equal((await result.evaluate("layout", async () => "control")).variant, "control");
  }
  assert.throws(() => createExperimentState({ secret: new Uint8Array(31) }));
  const open = createExperimentState({ secret });
  await assert.rejects(() => open("", "", experiments));
  await assert.rejects(() => open("", null, Array(9).fill(experiments[0])));
  await assert.rejects(() => open("", null, [experiments[0], experiments[0]]));
  await assert.rejects(() => open("", null, [{ ...experiments[0], control: "missing" }]));
  await assert.rejects(() => createExperimentState({ secret, clock: () => -1 })("", null, experiments));
});

test("retired experiments are pruned and concurrent evaluation preserves one assignment", async () => {
  const open = createExperimentState({ secret });
  const first = await open("", null, experiments);
  const results = await Promise.all([first.evaluate("layout", choose), first.evaluate("layout", async () => "control")]);
  assert.deepEqual(results[0], results[1]);
  const next = await open(header(await first.cookies()), null, [experiments[1]]);
  await assert.rejects(() => next.evaluate("layout", choose));
  assert.equal((await next.evaluate("next", choose)).variant, "treatment");
});

test("maximum-size cohorts fit browser cookies and definitions cannot change during evaluation", async () => {
  const active = Array.from({ length: 8 }, (_, i) => ({ key: `x${i}${"a".repeat(62)}`, control: "c".repeat(64), variants: ["c".repeat(64), "t".repeat(64)] }));
  const state = await createExperimentState({ secret })("", firstPrincipal, active);
  const keys = active.map(value => value.key);
  active[0].variants[1] = "changed";
  for (const key of keys) assert.equal((await state.evaluate(key, async () => "t".repeat(64))).variant, "t".repeat(64));
  assert.ok((await state.cookies()).every(cookie => cookie.length < 4096));
});


test("overlapping provider failures and unknown variants share one cohort decision", async () => {
  for (const result of ["treatment", "unknown", "failure"]) {
    const state = await createExperimentState({ secret })("", null, experiments);
    let finish!: () => void, calls = 0;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const first = state.evaluate("layout", async () => { calls++; await gate; if (result === "failure") throw Error("offline"); return result; });
    const second = state.evaluate("layout", async () => { calls++; return "control"; });
    await Promise.resolve(); finish();
    const values = await Promise.all([first, second]);
    assert.deepEqual(values[0], values[1]);
    assert.equal(calls, 1);
    assert.equal(values[0].variant, result === "treatment" ? "treatment" : "control");
    assert.equal((await state.evaluate("layout", choose)).variant, "treatment");
  }
});

test("key rotation preserves active anonymous and signed-in hashes while new experiments use the current key", async () => {
  const rotated = new Uint8Array(32).fill(98);
  for (const principal of [null, firstPrincipal]) {
    const original = await createExperimentState({ secret, clock: () => 100 })("", principal, experiments);
    const assigned = await original.evaluate("layout", choose);
    const open = createExperimentState({ secret: rotated, previousSecrets: [secret], clock: () => 101 });
    const next = await open(header(await original.cookies()), principal, experiments);
    assert.deepEqual(await next.evaluate("layout", async () => "control"), assigned);
    const added = await next.evaluate("next", choose);
    assert.notEqual(added.assignment_hash, assigned.assignment_hash);
    if (principal) assert.equal(added.assignment_hash, hashExperimentAssignment(principal, rotated));
    const rewritten = await createExperimentState({ secret: rotated, clock: () => 102 })(header(await next.cookies()), principal, experiments);
    assert.deepEqual(await rewritten.evaluate("layout", async () => "control"), assigned);
  }
});

test("rotation during sign-in preserves anonymous attribution and rejects cross-account reuse", async () => {
  const rotated = new Uint8Array(32).fill(98);
  const first = await createExperimentState({ secret })("", null, experiments);
  const assigned = await first.evaluate("layout", choose);
  const open = createExperimentState({ secret: rotated, previousSecrets: [secret] });
  const signedIn = await open(header(await first.cookies()), firstPrincipal, experiments);
  assert.deepEqual(await signedIn.evaluate("layout", choose), assigned);
  const priorAccount = await createExperimentState({ secret })("", firstPrincipal, experiments);
  await priorAccount.evaluate("layout", choose);
  for (const principal of [null, secondPrincipal]) {
    const other = await open(header(await priorAccount.cookies()), principal, experiments);
    assert.equal((await other.evaluate("layout", async () => "control")).variant, "control");
  }
});

test("previous signing keys are bounded, copied and explicitly configured", async () => {
  assert.throws(() => createExperimentState({ secret, previousSecrets: [new Uint8Array(31)] }));
  assert.throws(() => createExperimentState({ secret, previousSecrets: [secret, secret, secret, secret] }));
  const old = new Uint8Array(secret);
  const original = await createExperimentState({ secret: old })("", null, experiments);
  const assigned = await original.evaluate("layout", choose);
  const open = createExperimentState({ secret: new Uint8Array(32).fill(98), previousSecrets: [old] });
  old.fill(0);
  const restored = await open(header(await original.cookies()), null, experiments);
  assert.deepEqual(await restored.evaluate("layout", choose), assigned);
});


test("hash-key versions survive sign-in, rotation, restart and legacy state rewrites", async () => {
  const rotated = new Uint8Array(32).fill(98);
  const first = await createExperimentState({ secret, clock: () => 100 })("", null, experiments);
  await first.evaluate("layout", choose);
  assert.equal(first.assignmentKeyVersion("layout"), experimentKeyVersion(secret));
  const second = await createExperimentState({ secret: rotated, previousSecrets: [secret], clock: () => 101 })(
    header(await first.cookies()), firstPrincipal, experiments);
  await second.evaluate("next", choose);
  assert.equal(second.assignmentKeyVersion("layout"), experimentKeyVersion(secret));
  assert.equal(second.assignmentKeyVersion("next"), experimentKeyVersion(rotated));
  const cookies = await second.cookies();
  // Old instances rewrite only the original two cookies. Browsers keep this
  // independently signed companion until it is updated or expires.
  const raw = cookies[1].split(";")[0].slice(experimentStateCookie.length + 1);
  const { payload } = await jwtVerify(raw, rotated, { currentDate: new Date(102_000) });
  const oldRewrite = await new SignJWT({ state: payload.state })
    .setProtectedHeader({ alg: "HS256", typ: "s3rch-experiment-state-v1" })
    .setIssuer("s3rch").setAudience("s3rch-experiment-state-v1").setIssuedAt(102).setExpirationTime(31536102).sign(rotated);
  const rewrittenCookies = [cookies[0], `${experimentStateCookie}=${oldRewrite}`, cookies[2]];
  const restarted = await createExperimentState({ secret: rotated, clock: () => 103 })(header(rewrittenCookies), firstPrincipal, experiments);
  assert.equal(restarted.assignmentKeyVersion("layout"), experimentKeyVersion(secret));
  assert.equal(restarted.assignmentKeyVersion("next"), experimentKeyVersion(rotated));
  assert.equal(restarted.assignmentKeyVersion("absent"), null);
  assert.deepEqual(Object.keys(await restarted.evaluate("layout", choose)).sort(), ["assignment_hash", "experiment_key", "surface", "variant"]);
});

test("legacy or missing metadata remains unknown without resetting a valid cohort", async () => {
  const first = await createExperimentState({ secret })("", null, experiments);
  const assigned = await first.evaluate("layout", choose);
  const oldCookies = header((await first.cookies()).slice(0, 2));
  const restored = await createExperimentState({ secret })(oldCookies, null, experiments);
  assert.deepEqual(await restored.evaluate("layout", async () => "control"), assigned);
  assert.equal(restored.assignmentKeyVersion("layout"), null);
  const next = await createExperimentState({ secret })(header(await restored.cookies()), null, experiments);
  assert.equal(next.assignmentKeyVersion("layout"), null);
});

test("metadata is bound to the anonymous cookie and exact retained assignment", async () => {
  const open = createExperimentState({ secret });
  const one = await open("", firstPrincipal, experiments); await one.evaluate("layout", choose);
  const two = await open("", secondPrincipal, experiments); await two.evaluate("layout", choose);
  const firstCookies = await one.cookies(), secondCookies = await two.cookies();
  const mixed = await open(header([...firstCookies.slice(0, 2), secondCookies[2]]), firstPrincipal, experiments);
  assert.equal(mixed.assignmentKeyVersion("layout"), null);
  for (const principal of [null, secondPrincipal]) {
    const switched = await open(header(firstCookies), principal, experiments);
    assert.equal(switched.assignmentKeyVersion("layout"), null);
  }
  const pruned = await open(header(firstCookies), firstPrincipal, [experiments[1]]);
  assert.equal(pruned.assignmentKeyVersion("layout"), null);
  const tampered = await open(header(firstCookies).replace(`${experimentKeyVersionsCookie}=`, `${experimentKeyVersionsCookie}=x`), firstPrincipal, experiments);
  assert.equal(tampered.assignmentKeyVersion("layout"), null);
});
