import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { cp, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const build = path.resolve(".next/standalone");
const root = await mkdtemp(path.join(tmpdir(), "s3rch-seed-handoff-"));
// Select a free loopback port and reuse it across peer restarts.
const probe = createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const origin = "http://127.0.0.1:" + probe.address().port;
await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
const clientScript = createRequire(import.meta.url).resolve("gun/gun.js");
const soul = "handoff-" + randomUUID();
const revision = "a".repeat(40);
const snapshot = {
  items: [{ id: soul, source: "rss", kind: "post", author: "Reader", body: "Handoff fixture",
    ts: 1, tags: [], provenance: "RSS", permalink: "https://example.org/post" }],
  seededAt: "2026-01-01T00:00:00Z", sourcesOk: 1, sourcesTried: 1, error: null,
};
let browser;
let child;
let exit;
let log;

async function start(storage = "") {
  assert.equal(child, undefined, "the previous volume owner must exit first");
  // A replacement container gets a fresh public directory. Only GUN_SNAPSHOT survives.
  await rm(path.join(root, "public/feed-cache/snapshot.json"), { force: true });
  log = "";
  child = spawn(process.execPath, [...(storage ? ["--require", path.join(root, storage + "-storage.cjs")] : []), "seed-peer.cjs"], {
    cwd: root, env: {
      PATH: process.env.PATH, HOME: root, NODE_ENV: "production", HOSTNAME: "127.0.0.1", PORT: new URL(origin).port,
      ...(storage ? {
        S3RCH_FEED_STORAGE_ORIGIN: "https://storage.example",
        S3RCH_FEED_STORAGE_TENANT_ID: "11111111-1111-4111-8111-111111111111",
        S3RCH_FEED_STORAGE_API_KEY: "synthetic.unit.key",
      } : {}),
      APP_BUILD_REVISION: revision, GUN_FILE: path.join(root, "radata"), GUN_SNAPSHOT: path.join(root, "snapshot.json"),
    }, stdio: ["ignore", "pipe", "pipe"],
  });
  exit = once(child, "exit");
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { log = (log + chunk).slice(-8192); });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null || child.signalCode !== null) throw Error(log);
    const res = await fetch(origin + "/api/health", { signal: AbortSignal.timeout(1000) }).catch(() => null);
    if (res?.ok) {
      const identity = await fetch(origin + "/api/version");
      assert.equal(identity.status, 200);
      assert.match(identity.headers.get("cache-control") ?? "", /no-store/);
      assert.deepEqual(await identity.json(), { revision });
      const published = await fetch(origin + "/feed-cache/snapshot.json");
      assert.equal(published.status, 200);
      const observed = await published.json();
      // Restoration is asynchronous so local public reads remain available.
      if (!isDeepStrictEqual(observed, snapshot)) { await delay(100); continue; }
      assert.deepEqual(observed, snapshot);
      return;
    }
    await delay(100);
  }
  throw Error("Seed startup timed out: " + log);
}

async function stop() {
  if (!child) return;
  child.kill();
  const deadline = setTimeout(() => child.kill("SIGKILL"), 5000);
  try { await exit; } finally { clearTimeout(deadline); }
  child = undefined;
}

async function client() {
  // newPage creates a separate browser context with no shared graph or storage.
  const page = await browser.newPage();
  await page.goto(origin + "/api/health");
  await page.addScriptTag({ path: clientScript });
  await page.evaluate(key => {
    const gun = window.Gun({ peers: [], localStorage: false, RTCPeerConnection: false });
    window.seedGun = gun;
    window.connections = 0;
    gun._.on("hi", function (peer) {
      if (peer.url === location.origin + "/gun") window.connections++;
      this.to.next(peer);
    });
    gun.opt({ peers: [location.origin + "/gun"] });
    gun._.on("out", { dam: "hi" });
    window.record = gun.get(key);
    window.record.on(value => { window.observed = value?.phase; });
  }, soul);
  await page.waitForFunction(() => window.connections > 0);
  return page;
}

async function write(page, phase) {
  await page.evaluate(value => {
    window.record.put({ phase: value }, ack => {
      if (ack.err) window.writeError = String(ack.err);
      else window.acked = value;
    });
  }, phase);
  await page.waitForFunction(value => window.acked === value || window.writeError, phase);
  assert.equal(await page.evaluate(() => window.writeError), undefined);
}

const read = (page, phase) => page.waitForFunction(value => window.observed === value, phase);

try {
  for (const name of await readdir(build)) {
    if (name === "data") continue;
    const source = path.join(build, name), dest = path.join(root, name);
    if (name === "server.js" || name === "public") await cp(source, dest, { recursive: true });
    else await symlink(source, dest);
  }
  await writeFile(path.join(root, "snapshot.json"), JSON.stringify(snapshot));
  browser = await chromium.launch();
  await start();
  const original = await client();
  await write(original, "initial");
  await original.close();
  await stop();

  await start();
  const writer = await client(), reader = await client();
  await read(reader, "initial"); // Only the volume survived the handoff.
  await write(writer, "standalone");
  await read(reader, "standalone");
  const clients = [reader, writer];
  const before = await Promise.all(clients.map(peer => peer.evaluate(() => window.connections)));
  await stop();
  await start();
  // Both live clients must reconnect. A new value proves fresh remote delivery.
  await Promise.all(clients.map((peer, i) =>
    peer.waitForFunction(previous => window.connections > previous, before[i])));
  await write(reader, "reconnected");
  await read(writer, "reconnected");
  await writer.close();
  await reader.close();
  await stop();

  await start();
  const restored = await client();
  await read(restored, "reconnected");
  // Persist a source row in Gun, then model its successful-window retirement in
  // the durable snapshot while the peer is stopped. Restart must replay removal.
  await restored.evaluate(() => new Promise((resolve, reject) => {
    window.seedGun.get("s3rch").get("items").get("retired-source-post").put({
      id: "retired-source-post", source: "rss", body: "Retired source content", v: 1,
    }, ack => ack.err ? reject(Error(ack.err)) : resolve());
  }));
  await restored.close();
  await stop();
  snapshot.items = [];
  await writeFile(path.join(root, "snapshot.json"), JSON.stringify({
    ...snapshot, sourceWindows: [["retired-source", []]], retiredIds: ["retired-source-post"],
  }));
  await start();
  const afterRetirement = await client();
  await afterRetirement.evaluate(() => {
    window.seedGun.get("s3rch").get("items").get("retired-source-post").on(value => {
      window.retiredSource = value;
    });
  });
  await afterRetirement.waitForFunction(() => window.retiredSource?.unshared === 1 && window.retiredSource?.body === null);
  await afterRetirement.close();
  await stop();
  // A stalled storage provider must not delay health, public cache or Gun access.
  // This child-only mock makes no provider call; the nightly batch runs the case.
  await writeFile(path.join(root, "stalled-storage.cjs"), "globalThis.fetch = () => new Promise(() => {});\n");
  await start("stalled");
  const fallback = await client();
  await fallback.close();
  await stop();

  // This fixture replaces only outbound record HTTP in the child. The packaged
  // peer, record client, cache codec, disk publication and Gun are real.
  await cp(path.resolve("scripts/fixtures/record-storage.cjs"), path.join(root, "record-storage.cjs"));
  await start("record");
  for (let i = 0; i < 100; i++) {
    const imported = await readFile(path.join(root, "tenant-record.json"), "utf8").catch(() => null);
    if (imported) { assert.equal(JSON.parse(imported).version, 1); break; }
    if (i === 99) throw Error("Legacy cache import did not complete");
    await delay(100);
  }
  await stop();
  const adopted = JSON.parse(await readFile(path.join(root, "snapshot.json"), "utf8"));
  assert.equal(adopted.tenantRecordInitialized, true);

  // A new remote window wins over the persisted empty local cache after restart.
  snapshot.items = [{ id: "tenant-post", source: "rss", kind: "post", author: "Reader",
    body: "Tenant cache fixture", v: 1, ts: 2, tags: [], provenance: "RSS", permalink: "https://example.org/tenant-post" }];
  await writeFile(path.join(root, "tenant-record.json"), JSON.stringify({
    ...snapshot, version: 1, sourceWindows: [["tenant-source", snapshot.items]], retiredIds: [],
  }));
  await start("record");
  const remoteReader = await client();
  await remoteReader.evaluate(() => {
    window.seedGun.get("s3rch").get("items").get("tenant-post").on(value => { window.tenantPost = value; });
  });
  await remoteReader.waitForFunction(() => window.tenantPost?.body === "Tenant cache fixture");
  await remoteReader.close();
  await stop();

  // Successful-empty remote windows remove the previous public row and replay
  // its tombstone into the same surviving Gun volume.
  snapshot.items = [];
  await writeFile(path.join(root, "tenant-record.json"), JSON.stringify({
    ...snapshot, version: 1, sourceWindows: [["tenant-source", []]], retiredIds: [],
  }));
  await start("record");
  const removedReader = await client();
  await removedReader.evaluate(() => {
    window.seedGun.get("s3rch").get("items").get("tenant-post").on(value => { window.tenantPost = value; });
  });
  await removedReader.waitForFunction(() => window.tenantPost?.unshared === 1 && window.tenantPost?.body === null);
  await removedReader.close();
  await stop();

  // Once adopted, missing or malformed remote data keeps the local fallback
  // available and must never create a replacement from stale disk content.
  for (const corrupt of [false, true]) {
    if (corrupt) await writeFile(path.join(root, "tenant-record.json"), '{"version":999}');
    else await rm(path.join(root, "tenant-record.json"));
    await start("record");
    for (let i = 0; i < 100 && !log.includes("Tenant feed cache unavailable"); i++) await delay(100);
    assert.match(log, /Tenant feed cache unavailable/);
    const record = await readFile(path.join(root, "tenant-record.json"), "utf8").catch(() => null);
    assert.equal(record, corrupt ? '{"version":999}' : null);
    await stop();
  }
  console.log("Gun handoff, tenant cache restoration, retirement and failure preservation passed.");
} catch (error) {
  console.error(log);
  throw error;
} finally {
  try { await browser?.close(); } finally {
    await stop();
    await rm(root, { recursive: true, force: true });
  }
}
