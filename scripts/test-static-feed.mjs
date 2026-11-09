import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

// Test the production bundle. The dev server opens its own HMR socket.
const build = path.resolve(".next/standalone");
const root = await mkdtemp(path.join(tmpdir(), "s3rch-static-feed-"));
const port = process.env.STATIC_FEED_TEST_PORT || "3927";
const origin = "http://127.0.0.1:" + port;
const body = "A cached public feed row";
let server;
let browser;
try {
  for (const name of await readdir(build)) {
    const src = path.join(build, name);
    const dest = path.join(root, name);
    if (name === "data") continue;
    if (name === "public" || name === "server.js") await cp(src, dest, { recursive: true });
    else await symlink(src, dest);
  }
  await mkdir(path.join(root, "data"));
  await writeFile(path.join(root, "data/snapshot.json"), JSON.stringify({
    items: [{ id: "rss:cached", source: "rss", kind: "post", author: "Reader", body,
      ts: 1, tags: ["cached"], provenance: "RSS", permalink: "https://example.org/post" }],
    seededAt: null, sourcesOk: 1, sourcesTried: 1, error: null,
  }));
  server = spawn(process.execPath, ["-r", "./gun-preload.cjs", "server.js"], {
    cwd: root, env: { PATH: process.env.PATH, HOME: root, NODE_ENV: "production",
      PORT: port, HOSTNAME: "127.0.0.1" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  server.stdout.on("data", chunk => { log += chunk; });
  server.stderr.on("data", chunk => { log += chunk; });
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(log);
    const res = await fetch(origin + "/feed-cache/snapshot.json").catch(() => null);
    if (res?.ok && (await res.json()).items?.[0]?.body === body) break;
    if (i === 99) throw new Error("Snapshot startup failed: " + log);
    await delay(100);
  }
  browser = await chromium.launch();
  const page = await browser.newPage();
  const requests = [];
  const sockets = [];
  page.on("request", req => requests.push(new URL(req.url()).pathname));
  page.on("websocket", socket => sockets.push(socket));
  const snapshot = page.waitForResponse(res => res.url() === origin + "/feed-cache/snapshot.json");
  await page.goto(origin + "/feed");
  assert.match((await snapshot).headers()["cache-control"], /public.*max-age=[1-9]/);
  await page.getByText(body, { exact: true }).waitFor();
  await page.getByRole("button", { name: /cached/i }).click();
  assert.equal(new URL(page.url()).searchParams.get("tag"), "cached");
  // Longer than two of the former four-second session polling intervals.
  await delay(8500);
  assert.deepEqual(requests.filter(url => url.startsWith("/api/")), []);
  assert.equal(requests.filter(url => url === "/feed-cache/snapshot.json").length, 1);
  assert.deepEqual(sockets, []);

  const connected = page.waitForEvent("websocket", ws => new URL(ws.url()).pathname === "/gun");
  await page.getByRole("button", { name: "Network", exact: true }).click();
  const socket = await connected;
  const closed = socket.waitForEvent("close");
  await page.getByRole("button", { name: "Public", exact: true }).click();
  await closed;
  await page.getByText(body, { exact: true }).waitFor();
  await delay(500);
  const returned = requests.length;
  await delay(8500);
  assert.equal(sockets.length, 1);
  assert.deepEqual(requests.slice(returned).filter(url => url.startsWith("/api/")), []);
  assert.equal(requests.includes("/api/turn/allocate"), false);
  console.log("Signed-out public browsing, live opt-in, and disconnect passed.");
} finally {
  await browser?.close();
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = once(server, "exit");
    server.kill();
    await exited;
  }
  await rm(root, { recursive: true, force: true });
}
