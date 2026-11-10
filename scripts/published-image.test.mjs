import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { TRUSTED_RELEASE_FILES } from "./require-release-gates.mjs";

const image = "ghcr.io/fyberlabs/s3r.ch", digest = `sha256:${"ab".repeat(32)}`;
function run(mode = "ok", override = {}) {
  const dir = mkdtempSync(join(tmpdir(), "published-image-")), log = join(dir, "calls.jsonl");
  const executable = (name, source) => writeFileSync(join(dir, name), `#!${process.execPath}\n${source}`, { mode: 0o755 });
  executable("docker", `
    const fs = require("node:fs"), args = process.argv.slice(2), mode = process.env.TEST_MODE;
    fs.appendFileSync(process.env.TEST_LOG, JSON.stringify(args)+"\\n");
    if (args[0] === "--config") {
      if (fs.readdirSync(args[1]).length !== 0) process.exit(8);
      process.exit(mode === "pull-fails" ? 1 : 0);
    }
    if (args[0] === "image") {
      if (args.includes("{{.Config.User}}")) console.log("nextjs");
      else if (args.some(arg => arg.includes("org.opencontainers.image.revision"))) console.log("a".repeat(40));
      else process.exit(1);
    }
    if (args[0] === "run" && args.includes("id")) console.log("1001");
    if (args[0] === "run" && args.includes("node") && mode === "package-missing") process.exit(1);
    if (args[0] === "run" && args.includes("-d")) console.log("container-id");
    if (args[0] === "inspect") console.log(mode === "boot-fails" ? "false" : "true");
  `);
  executable("curl", `
    const path = new URL(process.argv.at(-1)).pathname;
    if (path === "/api/health") console.log(JSON.stringify({status:"ok",dependencies:{panopticon:{status:"not-configured"},gun:{status:"external"}}}));
    else if (path === "/api/version") console.log(JSON.stringify({revision:(process.env.TEST_MODE === "wrong-revision" ? "b" : "a").repeat(40)}));
    else process.exit(1);
  `);
  executable("sleep", "");
  try {
    const result = spawnSync("bash", [resolve("scripts/require-anonymous-pull.sh")], {
      encoding: "utf8", timeout: 15000,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_REPOSITORY: "FyberLabs/s3r.ch",
        IMAGE: image, VERSION: "0.1.0", DIGEST: digest, TEST_MODE: mode, TEST_LOG: log, ...override },
    });
    const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
    for (const args of calls.filter(args => args[0] === "--config")) assert.equal(existsSync(args[1]), false, "temporary credentials removed");
    return { ...result, calls };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("pulls and boots the immutable published digest, never the local rebuild or mutable version tag", () => {
  const r = run(); assert.equal(r.status, 0, r.stderr);
  const pulls = r.calls.filter(args => args[0] === "--config");
  assert.equal(pulls.length, 1); assert.deepEqual(pulls[0].slice(2), ["pull", `${image}@${digest}`]);
  const runs = r.calls.filter(args => args[0] === "run");
  assert.ok(runs.some(args => args.includes("-d")), "actually boots the published image");
  assert.ok(runs.some(args => args.some(a => a.includes("require.resolve('viem')"))));
  assert.ok(runs.every(args => args.includes(`${image}@${digest}`)));
  assert.ok(!r.calls.flat().includes("s3rch:release"));
  assert.ok(!r.calls.flat().includes(`${image}:0.1.0`));
});
for (const mode of ["pull-fails", "package-missing", "boot-fails", "wrong-revision"]) test(`published artifact gate fails closed when ${mode}`, () => {
  const r = run(mode); assert.notEqual(r.status, 0);
  if (mode === "pull-fails") {
    assert.equal(r.calls.filter(args => args[0] === "--config").length, 5);
    assert.equal(r.calls.filter(args => args[0] === "run").length, 0);
  }
});
for (const value of ["", "sha256:bad", `sha256:${"ab".repeat(32)};echo injected`]) test(`rejects invalid digest ${JSON.stringify(value)}`, () => {
  const r = run("ok", { DIGEST: value }); assert.notEqual(r.status, 0); assert.equal(r.calls.length, 0);
});
test("test image is anonymously checked before deployment and publication; promotion does not rebuild", () => {
  const testWorkflow = readFileSync(".github/workflows/deploy.yml", "utf8");
  const releaseWorkflow = readFileSync(".github/workflows/release.yml", "utf8");
  const gate = testWorkflow.indexOf("name: Verify public package");
  const deployment = testWorkflow.indexOf("name: Deploy and verify");
  const publication = testWorkflow.indexOf("name: Publish successful test release");
  assert.ok(gate > 0 && deployment > gate && publication > deployment);
  assert.doesNotMatch(releaseWorkflow, /build-push-action|docker build|npm run build/);
  assert.match(releaseWorkflow, /release-channels.mjs promote/);
  assert.ok(TRUSTED_RELEASE_FILES.includes("scripts/release-channels.mjs"));
});

test("TEST waits for storage after the target revision appears, within a fixed deadline", () => {
  const sha = "a".repeat(40);
  const fixture = `
    import timers from "node:timers/promises";
    import { syncBuiltinESMExports } from "node:module";
    let now = 0;
    Date.now = () => now;
    timers.setTimeout = async (ms) => { now += ms; };
    syncBuiltinESMExports();
    globalThis.fetch = async (url) => {
      if (now > 600000) throw Error("unbounded verification");
      const revision = now >= 240000 ? "${sha}" : "b".repeat(40);
      const writable = now >= Number(process.env.READY_AT);
      const body = url.endsWith("/api/version") ? { revision } : {
        status: "ok", dependencies: { identity: { status: writable ? "ok" : "checking", writable }, gun: { status: "ok" } }
      };
      return Response.json(body);
    };
    process.on("exit", () => console.log("elapsed", now));
  `;
  function verify(origin, readyAt) {
    return spawnSync(process.execPath, [
      "--import", "data:text/javascript," + encodeURIComponent(fixture),
      "scripts/verify-deployed-release.mjs", origin, sha,
    ], { encoding: "utf8", timeout: 5000, env: { ...process.env, READY_AT: String(readyAt) } });
  }
  const cold = verify("https://test.s3r.ch", 360000);
  assert.equal(cold.status, 0, cold.stderr);
  const unavailable = verify("https://test.s3r.ch", Infinity);
  assert.equal(unavailable.status, 1, unavailable.stderr);
  assert.match(unavailable.stderr, /"writable":false/);
  assert.match(unavailable.stdout, /elapsed 540000/);
  const prod = verify("https://s3r.ch", 360000);
  assert.equal(prod.status, 1, prod.stderr);
  assert.match(prod.stdout, /elapsed 300000/);
});
