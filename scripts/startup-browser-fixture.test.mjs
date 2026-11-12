import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, chmod, symlink, link, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateStartupBrowserFixture, loadStartupBrowserFixture, scheduledStartupBrowser } from "./startup-browser-fixture.mjs";
const id = n => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
function fixture() {
  const pub = "A".repeat(43) + "." + "B".repeat(43);
  return { version: 1, site_origin: "https://site.example", sea_record: {
    address: "0x" + "a".repeat(40), seaPub: pub,
    seaPair: { pub, priv: "private-test-value", epub: pub, epriv: "private-test-value" },
    walletSignature: "test-signature", signedPayload: "test-payload" },
    expected: { sea_public_key: pub, person_id: id(1), tenant_id: id(2), organization_ids: [id(3),id(4),id(5)], binding_sha256: "a".repeat(64), mapping_sha256: "b".repeat(64) },
    negative_organization_id: id(6), login: { driver: "form-v1", origins: ["https://login.example"], credentials: { username: "test-user" },
      steps: [{ action: "fill", origin: "https://login.example", selector: "#username", credential: "username" }, { action: "click", origin: "https://login.example", selector: "#submit" }] } };
}
test("browser qualification is restricted to the central scheduled main context", () => {
  const env = { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "schedule", GITHUB_WORKFLOW_REF: "FyberLabs/infra/.github/workflows/nightly-integration.yml@refs/heads/main", NIGHTLY_SUITE: "startup-linked-browser", GITHUB_REPOSITORY: "FyberLabs/s3r.ch", GITHUB_REF: "refs/heads/master" };
  assert.equal(scheduledStartupBrowser(env), true);
  for (const key of Object.keys(env)) assert.equal(scheduledStartupBrowser({ ...env, [key]: "wrong" }), false);
});
test("browser projection snapshots explicit scopes and rejects credential injection", () => {
  const input = fixture(), result = validateStartupBrowserFixture(input);
  input.login.credentials.username = "changed";
  assert.equal(result.login.credentials.username, "test-user");
  for (const mutate of [v => v.owner_token = "secret", v => v.storageState = {},
    v => v.login.credentials.access_token = "secret", v => v.login.steps[0].origin = "https://foreign.example",
    v => v.login.steps[0].credential = "missing", v => v.negative_organization_id = id(3),
    v => v.expected.organization_ids[1] = id(3), v => v.sea_record.seaPair.pub = "wrong",
    v => v.site_origin = "http://site.example", v => v.login.origins = [v.site_origin],
    v => v.login.steps[0].selector = "", v => v.expected.mapping_sha256 = "bad"]) {
    const value = fixture(); mutate(value);
    assert.throws(() => validateStartupBrowserFixture(value), /fixture unavailable/);
  }
});
test("browser secret requires a bounded private regular unlinked file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "startup-browser-unit-")), path = join(dir, "fixture.json");
  try {
    await writeFile(path, JSON.stringify(fixture()), { mode: 0o600 });
    assert.equal((await loadStartupBrowserFixture(path)).version, 1);
    await chmod(path, 0o644); await assert.rejects(loadStartupBrowserFixture(path)); await chmod(path, 0o600);
    await symlink(path, join(dir, "sym")); await assert.rejects(loadStartupBrowserFixture(join(dir, "sym")));
    await link(path, join(dir, "hard")); await assert.rejects(loadStartupBrowserFixture(path)); await rm(join(dir, "hard"));
    await writeFile(path, "x".repeat(65537)); await assert.rejects(loadStartupBrowserFixture(path));
    await assert.rejects(loadStartupBrowserFixture("relative.json"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
