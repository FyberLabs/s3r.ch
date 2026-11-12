import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdtemp, writeFile, chmod, symlink, link, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStartupLoginConfig, readStartupLoginConfig } from "./startup-login-config";
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
