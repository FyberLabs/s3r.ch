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
const liveBody = "A delayed revision from the mesh";
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
  // Identity and Gun are controlled fixture endpoints for this browser check.
  const feedRows = page.locator("[data-feed-item]");
  let signedIn = false;
  await page.route("**/api/identity/session", route => signedIn
    ? route.fulfill({ json: {
      address: "0x0000000000000000000000000000000000000735", chainId: 1,
      owner: "axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU",
    } })
    : route.fulfill({ status: 401, json: {} }));
  await page.route("**/api/identity/logout", route => {
    signedIn = false;
    return route.fulfill({ json: {} });
  });
  await page.route("**/api/turn/allocate", route => route.fulfill({ status: 401, json: {} }));
  const requests = [];
  const sockets = [];
  let subscribed;
  const subscription = new Promise(resolve => { subscribed = resolve; });
  let connectSocket, closeSocket;
  const connected = new Promise(resolve => { connectSocket = resolve; });
  const closed = new Promise(resolve => { closeSocket = resolve; });
  await page.routeWebSocket("**/gun", socket => {
    sockets.push(socket);
    socket.onClose(closeSocket);
    connectSocket();
    if (sockets.length === 2) {
      socket.onMessage(message => {
        if (typeof message === "string" && message.includes('"get"') && message.includes('"s3rch"')) {
          subscribed(socket);
        }
      });
    }
  });
  page.on("request", req => requests.push(new URL(req.url()).pathname));
  const snapshot = page.waitForResponse(res => res.url() === origin + "/feed-cache/snapshot.json");
  await page.goto(origin + "/feed");
  assert.match((await snapshot).headers()["cache-control"], /public.*max-age=[1-9]/);
  await page.getByText(body, { exact: true }).waitFor();
  const anonymousRows = await feedRows.allTextContents();
  assert.equal(anonymousRows.length, 1);
  await page.getByRole("button", { name: /cached/i }).click();
  assert.equal(new URL(page.url()).searchParams.get("tag"), "cached");
  // Longer than two of the former four-second session polling intervals.
  await delay(8500);
  assert.deepEqual(requests.filter(url => url.startsWith("/api/")), [], "Public snapshot must not start identity or room API requests");
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
  signedIn = true;
  const accountRequest = page.waitForRequest(request => new URL(request.url()).pathname === "/api/identity/session");
  await page.getByRole("button", { name: "Account and posting", exact: true }).click();
  await accountRequest;
  const signOut = page.getByRole("button", { name: "Sign out", exact: true });
  await signOut.waitFor();
  await page.getByText(body, { exact: true }).waitFor();
  assert.deepEqual(await feedRows.allTextContents(), anonymousRows);

  const privateBody = "A post visible only in Mine";
  await page.getByLabel("Body", { exact: true }).fill(privateBody);
  await page.getByRole("button", { name: "Post to Mine", exact: true }).click();
  await page.getByText("Saved.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Mine", exact: true }).click();
  await page.getByText(privateBody, { exact: true }).waitFor();
  await page.getByRole("button", { name: "Network", exact: true }).click();

  const socket = await Promise.race([
    subscription, delay(10000).then(() => { throw Error("Gun did not subscribe"); }),
  ]);
  const state = Date.now() - 1000;
  const graphNode = (soul, fields) => ({
    _: { "#": soul, ">": Object.fromEntries(Object.keys(fields).map(key => [key, state])) },
    ...fields,
  });
  socket.send(JSON.stringify({ "#": "public-feed-parity", put: {
    s3rch: graphNode("s3rch", { items: { "#": "fixture/items" } }),
    "fixture/items": graphNode("fixture/items", { cached: { "#": "fixture/items/cached" } }),
    "fixture/items/cached": graphNode("fixture/items/cached", {
      id: "rss:cached", source: "rss", kind: "post", author: "Reader", body: liveBody,
      ts: 1, tags: "cached", provenance: "RSS", permalink: "https://example.org/post",
    }),
  } }));
  await page.getByText(liveBody, { exact: true }).waitFor();
  await page.getByRole("button", { name: "Public", exact: true }).click();
  assert.deepEqual(await feedRows.allTextContents(), anonymousRows);
  assert.equal(requests.filter(url => url === "/feed-cache/snapshot.json").length, 1);
  await page.getByRole("button", { name: "Account and posting", exact: true }).click();
  await signOut.click();
  await signOut.waitFor({ state: "hidden" });
  await page.getByText(body, { exact: true }).waitFor();
  assert.deepEqual(await feedRows.allTextContents(), anonymousRows);

  const forumReads = () => requests.filter(url => url === "/api/forum").length;
  await page.route("**/api/forum", route => route.fulfill({ status: 401, json: {} }));
  await page.goto(origin + "/forum");
  await page.getByText("Sign in to see a forum channel.").waitFor();
  const reads = forumReads();
  const identityReads = requests.filter(url => url === "/api/identity/session").length;
  await delay(8500);
  assert.equal(forumReads(), reads);
  assert.equal(requests.filter(url => url === "/api/identity/session").length, identityReads);
  console.log("Public snapshot parity across account changes and delayed mesh traffic passed.");
} finally {
  await browser?.close();
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = once(server, "exit");
    server.kill();
    await exited;
  }
  await rm(root, { recursive: true, force: true });
}
