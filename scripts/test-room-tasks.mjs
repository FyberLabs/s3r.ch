import { writeNightlyCaseResults } from "./nightly-case-results.mjs";
import path from "node:path";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { build } from "esbuild";
import { chromium } from "playwright-core";

if (process.env.GITHUB_ACTIONS !== "true") throw Error("Room task browser contracts run in CI only");

// Isolated component/browser contract. No shared TEST or external endpoints.
const caseNames=["setup","create-status-assignment","mine-share-privacy","shared-copy","signed-replay","access-and-draft-isolation","capacity","cleanup"];
const outcomes=new Map();let activeCase="setup";
function begin(name){outcomes.set(activeCase,"passed");activeCase=name;}
async function main(){
let other, browser;
const bundle = await build({ entryPoints: ["scripts/fixtures/room-tasks.tsx"], bundle: true,
  plugins: [{name:"fixture-authority", setup(build){build.onResolve({filter:/\/(RoomAuthorityProvider|useIdentitySession)$/},()=>({path:path.resolve("scripts/fixtures/room-task-authority.ts")}));}}],
  external: ["node:module", "crypto", "@peculiar/webcrypto"],
  write: false, platform: "browser", format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"test"' } });
const server = createServer((req, res) => {
  res.setHeader("cache-control", "no-store");
  if (req.url === "/fixture.js") { res.setHeader("content-type", "text/javascript"); res.end(bundle.outputFiles[0].contents); return; }
  if (req.url === "/") { res.setHeader("content-type", "text/html"); res.end('<!doctype html><html><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'); return; }
  res.writeHead(404).end();
});
try {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  const page = await browser.newPage();
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.goto(origin);
  await page.getByLabel("Title", { exact: true }).waitFor();
  other=await page.getByLabel("Other identity").textContent();
  begin("create-status-assignment");
  await page.getByLabel("Title", { exact: true }).fill("Private review");
  await page.getByRole("button", { name: "Add work", exact: true }).click();
  await page.getByText("Saved in Mine.", { exact: true }).waitFor();
  await page.getByLabel("Status for Private review").selectOption("doing");
  await page.getByText("Mine · doing · Unassigned", { exact: true }).waitFor();
  await page.getByLabel("Assignee for Private review").fill(other);
  await page.getByRole("button", { name: "Set assignee", exact: true }).click();
  await page.getByText(`Mine · doing · Assigned to ${other}`, { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Published events").textContent(), "0");
  begin("mine-share-privacy");
  await page.getByRole("button", { name: "Toggle shared room" }).click();
  await page.getByLabel("Status for Private review").selectOption("done");
  await page.getByText(`Mine · done · Assigned to ${other}`, { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Published events").textContent(), "0", "sharing the room cannot publish private task updates");
  begin("shared-copy");
  await page.getByRole("button", { name: "Share a copy", exact: true }).click();
  await page.getByText(`Shared in room · done · Assigned to ${other}`, { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Published events").textContent(), "1");
  await page.getByLabel("Work kind", { exact: true }).selectOption("issue");
  await page.getByLabel("Title", { exact: true }).fill("Shared issue");
  await page.getByRole("button", { name: "Add work", exact: true }).click();
  await page.getByText("Sent to this room.", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Published events").textContent(), "2");
  begin("signed-replay");
  await page.reload();
  await page.getByText(`Mine · done · Assigned to ${other}`, { exact: true }).waitFor();
  await page.getByText("Issue: Shared issue", { exact: true }).waitFor();
  begin("access-and-draft-isolation");
  await page.getByLabel("Title", { exact: true }).fill("Unsent private draft");
  await page.getByRole("button", { name: "Switch to reader without access" }).click();
  await page.getByText("Room access is required to view or change work.", { exact: true }).waitFor();
  assert.equal(await page.getByText("Task: Private review", { exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Add work", exact: true }).count(), 0);
  await page.getByRole("button", { name: "Grant other room access" }).click();
  await page.getByText("Issue: Shared issue", { exact: true }).waitFor();
  assert.equal(await page.getByText(`Mine · done · Assigned to ${other}`, { exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Set assignee", exact: true }).count(), 0, "assignment and room see do not grant editing authority");
  await page.getByRole("button", { name: "Switch back to owner" }).click();
  await page.getByLabel("Title", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Title", { exact: true }).inputValue(), "");
  begin("capacity");
  const beforeCapacity = await page.getByLabel("Published events").textContent();
  await page.getByRole("button", { name: "Simulate full raw history" }).click();
  await page.getByText("This room’s work history is at capacity. New work and updates are unavailable here.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Add work", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Set assignee", exact: true }).count(), 0);
  assert.equal(await page.getByLabel("Published events").textContent(), beforeCapacity);
  assert.deepEqual(errors, []);
  console.log("PASS room tasks: creation, status, assignment, private scope after room share, shared publication, reload, access loss, shared copy and draft isolation; Chromium " + browser.version());
} catch(error) { outcomes.set(activeCase,"failed"); throw error; } finally {
  if(!outcomes.has(activeCase))outcomes.set(activeCase,"passed");activeCase="cleanup";
  const cleanup=await Promise.allSettled([
    browser?.close(),
    (async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));})(),
  ]);
  if(cleanup.some(result=>result.status==="rejected"))throw Error("Fixture cleanup failed");
  outcomes.set("cleanup","passed");
}

}
await main().catch(()=>{if(!outcomes.has(activeCase))outcomes.set(activeCase,"failed");process.exitCode=1;console.error("Room task contract failed.");}).finally(()=>{
 const result=writeNightlyCaseResults({suite:"signed-room-tasks",expectedCases:caseNames,
  cases:caseNames.map(name=>({name,status:outcomes.get(name)??"blocked"}))});
 if(result.status!=="passed")process.exitCode=1;
});
