import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdtemp, writeFile, chmod, symlink, link, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStartupLoginConfig, readStartupLoginConfig, TEST_GITHUB_MEMBER_ENDPOINT } from "./startup-login-config";
import { resolveStartupLinkedIdentity } from "./startup-linked-login";
import hashes from "./vectors/startup-deployment-hash.json";
const fixture = () => readFile(new URL("./vectors/startup-deployment.json", import.meta.url));
const env = { S3RCH_STARTUP_LOGIN_ENABLED: "1", S3RCH_STARTUP_LOGIN_PROVIDER: "panopticon",
  S3RCH_STARTUP_AUTH_URL: "https://auth.example.invalid/auth/startup/identity",
  S3RCH_OAUTH_ISSUER: "https://startup.example.invalid/realms/isolated", S3RCH_OAUTH_CLIENT_ID: "s3rch-web" };

test("canonical shared deployment vector produces the same binding and mapping hashes", async () => {
  const result = parseStartupLoginConfig(await fixture(), env);
  assert.equal(result.binding.binding_sha256, hashes.binding_sha256);
  assert.equal(result.binding.mapping_sha256, hashes.mapping_sha256);
  assert.equal(result.alias, "startup-entra");
  assert.equal(result.provider.issuer, env.S3RCH_OAUTH_ISSUER);
  assert.equal(result.endpoint, env.S3RCH_STARTUP_AUTH_URL);
  assert.deepEqual(result.binding.organizations.map(row => row.slug), ["fyberlabs", "hyperme.sh", "tennesseewindage"]);
  assert.ok(!("profile" in result.binding) && !("platform_admin" in result.binding));
});

test("noncanonical bytes, duplicate fields, altered binding and mismatched provider refuse", async () => {
  const raw = await fixture();
  for (const value of [Buffer.from("{}"), Buffer.from("null\n"), Buffer.alloc(16385), new Uint8Array([255]),
    Buffer.from(JSON.stringify(JSON.parse(raw.toString()), null, 2)),
    Buffer.from(raw.toString().replace('"schema_version":1', '"schema_version":1,"schema_version":1')),
    Buffer.from(raw.toString().replace('"startup-entra"', '"different"'))]) {
    assert.throws(() => parseStartupLoginConfig(value, env), /configuration unavailable/);
  }
  for (const override of [{ S3RCH_OAUTH_ISSUER: "https://other.invalid" }, { S3RCH_OAUTH_CLIENT_ID: "other" },
    { S3RCH_STARTUP_AUTH_URL: "http://auth.invalid/auth/startup/identity" }, { S3RCH_STARTUP_AUTH_URL: "bad" },
    { S3RCH_STARTUP_AUTH_URL: env.S3RCH_STARTUP_AUTH_URL + "?query=1" }, { S3RCH_STARTUP_LOGIN_PROVIDER: "missing" }]) {
    assert.throws(() => parseStartupLoginConfig(raw, { ...env, ...override }), /configuration unavailable/);
  }
});

test("disabled startup does no file read; enabled requires a private owned regular file", async () => {
  assert.equal(await readStartupLoginConfig({ STARTUP_IDENTITY_CONFIG_FILE: "/missing" }), null);
  await assert.rejects(readStartupLoginConfig(env));
  await assert.rejects(readStartupLoginConfig({ ...env, STARTUP_IDENTITY_CONFIG_FILE: "relative" }));
  const directory = await mkdtemp(join(tmpdir(), "startup-config-"));
  try {
    const path = join(directory, "mapping.json"), alias = join(directory, "alias");
    await writeFile(path, await fixture(), { mode: 0o600 });
    assert.equal((await readStartupLoginConfig({ ...env, STARTUP_IDENTITY_CONFIG_FILE: path }))?.binding.mapping_sha256, hashes.mapping_sha256);
    await chmod(path, 0o640);
    await assert.rejects(readStartupLoginConfig({ ...env, STARTUP_IDENTITY_CONFIG_FILE: path }));
    await chmod(path, 0o600); await symlink(path, alias);
    await assert.rejects(readStartupLoginConfig({ ...env, STARTUP_IDENTITY_CONFIG_FILE: alias }));
    await rm(alias); await link(path, alias);
    await assert.rejects(readStartupLoginConfig({ ...env, STARTUP_IDENTITY_CONFIG_FILE: path }));
    await assert.rejects(readStartupLoginConfig({ ...env, STARTUP_IDENTITY_CONFIG_FILE: directory }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a TEST GitHub member resolves the existing key without organization or platform grants", async () => {
  const subject = "00000000-0000-4000-8000-000000000121";
  const person = "00000000-0000-4000-8000-000000000122";
  const issuer = "https://auth.test.hyperme.sh/realms/controlplane";
  const sea_public_key = JSON.parse((await fixture()).toString()).binding.sea_public_key;
  const mapping = { broker: { audience: "s3rch-web", issuer, provider: "github", subject }, environment: "test",
    network_id: "hyperme.sh", sea_public_key, tenant_id: "00000000-0000-4000-8000-000000000123", version: 1 };
  const memberEnv = { ...env, S3RCH_OAUTH_ISSUER: issuer, S3RCH_STARTUP_AUTH_URL: TEST_GITHUB_MEMBER_ENDPOINT,
    S3RCH_STARTUP_GITHUB_MEMBER_CONFIG: JSON.stringify(mapping) + "\n" };
  const config = await readStartupLoginConfig(memberEnv);
  assert.ok(config);
  assert.equal(config.alias, "github");
  assert.deepEqual(config.binding.organizations, []);
  const identity = { ...config.binding, schema_version: 1, status: "resolved", permissions: [],
    person_id: person, broker_subject: subject };
  const existing = { sea_public_key };
  assert.deepEqual(resolveStartupLinkedIdentity(identity, config.binding, subject, existing)?.github, { subject });
  assert.equal(resolveStartupLinkedIdentity({ ...identity, broker_subject: person }, config.binding, person, existing), null);
  assert.equal(resolveStartupLinkedIdentity({ ...identity, permissions: ["admin"] }, config.binding, subject, existing), null);
  await assert.rejects(readStartupLoginConfig({ ...memberEnv, S3RCH_STARTUP_AUTH_URL: env.S3RCH_STARTUP_AUTH_URL }));
  await assert.rejects(readStartupLoginConfig({ ...memberEnv, STARTUP_IDENTITY_CONFIG_FILE: "/operator.json" }));
});
