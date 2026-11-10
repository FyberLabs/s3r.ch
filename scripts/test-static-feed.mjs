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
  await writeFile(path.join(root, "public/feed-cache/snapshot.json"), JSON.stringify({
    items: [{ id: "rss:cached", source: "rss", kind: "post", author: "Reader", body,
      ts: 1, tags: ["cached"], provenance: "RSS", permalink: "https://example.org/post" }],
    seededAt: null, sourcesOk: 1, sourcesTried: 1, error: null,
  }));
  server = spawn(process.execPath, ["server.js"], {
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
  // This test covers opt-in and cleanup; the peer restart test exercises Gun.
  const requests = [];
  const sockets = [];
  let connectSocket, closeSocket;
  const connected = new Promise(resolve => { connectSocket = resolve; });
  const closed = new Promise(resolve => { closeSocket = resolve; });
  await page.routeWebSocket("**/gun", socket => {
    sockets.push(socket);
    socket.onClose(closeSocket);
    connectSocket();
  });
  page.on("request", req => requests.push(new URL(req.url()).pathname));
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

  await page.getByRole("button", { name: "Network", exact: true }).click();
  await Promise.race([connected, delay(10000).then(() => { throw Error("Gun did not connect"); })]);
  await page.getByRole("button", { name: "Public", exact: true }).click();
  await Promise.race([closed, delay(10000).then(() => { throw Error("Gun did not disconnect"); })]);
  await page.getByText(body, { exact: true }).waitFor();
  await delay(500);
  const returned = requests.length;
  await delay(8500);
  assert.equal(sockets.length, 1);
  assert.deepEqual(requests.slice(returned).filter(url => url.startsWith("/api/")), []);
  assert.equal(requests.includes("/api/turn/allocate"), false);
  const forumReads = () => requests.filter(url => url === "/api/forum").length;
  await page.route("**/api/forum", route => route.fulfill({ status: 401, json: {} }));
  await page.goto(origin + "/forum");
  await page.getByText("Sign in to see a forum channel.").waitFor();
  const reads = forumReads();
  const identityReads = requests.filter(url => url === "/api/identity/session").length;
  await delay(8500);
  assert.equal(forumReads(), reads);
  assert.equal(requests.filter(url => url === "/api/identity/session").length, identityReads);
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
