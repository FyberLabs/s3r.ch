import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { cp, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const build = path.resolve(".next/standalone");
const root = await mkdtemp(path.join(tmpdir(), "s3rch-seed-handoff-"));
// Select a free loopback port and reuse it across both relay implementations.
const probe = createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const origin = "http://127.0.0.1:" + probe.address().port;
await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
const clientScript = createRequire(import.meta.url).resolve("gun/gun.js");
const soul = "handoff-" + randomUUID();
let browser;
let child;
let exit;
let log;

async function start(embedded) {
  assert.equal(child, undefined, "the previous volume owner must exit first");
  log = "";
  child = spawn(process.execPath, embedded ? ["-r", "./gun-preload.cjs", "server.js"] : ["seed-peer.cjs"], {
    cwd: root, env: {
      PATH: process.env.PATH, HOME: root, NODE_ENV: "production", HOSTNAME: "127.0.0.1", PORT: new URL(origin).port,
      GUN_FILE: path.join(root, "radata"), GUN_SNAPSHOT: path.join(root, "snapshot.json"),
    }, stdio: ["ignore", "pipe", "pipe"],
  });
  exit = once(child, "exit");
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { log = (log + chunk).slice(-8192); });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null || child.signalCode !== null) throw Error(log);
    const res = await fetch(origin + "/api/health", { signal: AbortSignal.timeout(1000) }).catch(() => null);
    if (res?.ok) return;
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
  browser = await chromium.launch();
  await start(true);
  const original = await client();
  await write(original, "embedded");
  await original.close();
  await stop();

  await start(false);
  const writer = await client(), reader = await client();
  await read(reader, "embedded"); // Only the volume survived the handoff.
  await write(writer, "standalone");
  await read(reader, "standalone");
  const clients = [reader, writer];
  const before = await Promise.all(clients.map(peer => peer.evaluate(() => window.connections)));
  await stop();
  await start(false);
  // Both live clients must reconnect. A new value proves fresh remote delivery.
  await Promise.all(clients.map((peer, i) =>
    peer.waitForFunction(previous => window.connections > previous, before[i])));
  await write(reader, "reconnected");
  await read(writer, "reconnected");
  await writer.close();
  await reader.close();
  await stop();

  await start(true);
  const restored = await client();
  await read(restored, "reconnected");
  console.log("Gun graph handoff, two-client seed fallback, reconnect and embedded rollback passed.");
} catch (error) {
  console.error(log);
  throw error;
} finally {
  try { await browser?.close(); } finally {
    await stop();
    await rm(root, { recursive: true, force: true });
  }
}
