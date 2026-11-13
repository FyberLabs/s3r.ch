// Real product pages and provider forms; scheduled central CI only.
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadExperimentBrowserFixture, scheduledExperiments } from "./experiment-browser-fixture.mjs";
const cases = [];
const report = (status, reason) => console.log(JSON.stringify({ schema_version: 1, status, ...(reason ? { reason } : {}), cases }));
if (!scheduledExperiments(process.env)) { report("blocked", "scheduled-infra-context-required"); process.exitCode = 78; }
else {
  let browser, context, page, fixture, status = "failed", reason = "experiment-browser-unavailable";
  try {
    fixture = await loadExperimentBrowserFixture(process.env.NIGHTLY_FLAGS_BROWSER_FIXTURE_FILE);
    const output = process.env.NIGHTLY_FLAGS_OBSERVATIONS_FILE;
    assert.ok(output && output.startsWith("/") && dirname(resolve(output)) === dirname(resolve(process.env.NIGHTLY_FLAGS_BROWSER_FIXTURE_FILE)));
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({ headless: true }); context = await browser.newContext();
    page = await context.newPage(); page.setDefaultTimeout(30000);
    const evaluations = [], events = [], pending = new Set();
    page.on("response", response => {
      const work = (async () => {
        if (response.url() !== fixture.site_origin + "/api/experiments" || response.request().method() !== "POST" || !response.ok()) return;
        const body = response.request().postDataJSON(), result = await response.json();
        if (body.action === "evaluate") evaluations.push(result);
        if (["exposure", "conversion"].includes(body.action) && result.accepted === true) {
          const payload = JSON.parse(Buffer.from(body.display.split(".")[1], "base64url")).payload;
          events.push({ event_id: body.eventId, event_type: body.action === "exposure" ? "experiment.exposure.v1" : "experiment.conversion.v2",
            assignment_hash: payload.assignment_hash, variant: payload.variant });
        }
      })(); pending.add(work); void work.catch(() => {}).finally(() => pending.delete(work));
    });
    async function until(check) { const end = Date.now() + 45000; while (!check()) { if (Date.now() >= end) throw Error("Product observation unavailable"); await page.waitForTimeout(100); } }
    await page.goto(fixture.site_origin);
    await page.getByRole("button", { name: "Allow page experiments and product analytics", exact: true }).click();
    await until(() => evaluations.length && events.some(e => e.event_type === "experiment.exposure.v1"));
    const original = evaluations.at(-1); assert.match(original.cohort, /^[a-f0-9]{64}$/); assert.equal(original.authenticated, false);
    assert.equal(events.at(-1).assignment_hash, original.cohort);
    cases.push({ name: "anonymous-visible-exposure", status: "passed" });
      await page.evaluate(async record => {
        await new Promise((resolve, reject) => {
          const request = indexedDB.open("s3rch-identity", 1);
          request.onupgradeneeded = () => request.result.createObjectStore("mesh-keys", { keyPath: "address" });
          request.onerror = () => reject(Error("Key staging failed"));
          request.onsuccess = () => {
            const db = request.result, tx = db.transaction("mesh-keys", "readwrite");
            tx.objectStore("mesh-keys").add(record);
            tx.oncomplete = () => { db.close(); resolve(null); };
            tx.onabort = () => { db.close(); reject(Error("Key staging failed")); };
          };
        });
      }, fixture.sea_record);
    const panel = page.getByTestId("startup-linked-login");
    await panel.getByRole("link", { name: "Sign in with your linked organization account" }).click();
    for (const step of fixture.login.steps) {
      await page.waitForURL(url => url.origin === step.origin || (url.origin === fixture.site_origin && url.searchParams.get("startup") === "linked"));
      if (new URL(page.url()).origin === fixture.site_origin) break;
      assert.equal(new URL(page.url()).origin, step.origin);
      const target = page.locator(step.selector);
      if (step.action === "fill") await target.fill(fixture.login.credentials[step.credential]); else await target.click();
    }
    await page.waitForURL(url => url.origin === fixture.site_origin && url.searchParams.get("startup") === "linked");
    await panel.getByText("Connected existing identity", { exact: false }).waitFor();
    const exchange = page.waitForResponse(response => response.url() === fixture.site_origin + "/api/identity/sea/exchange" && response.request().method() === "POST");
    await page.getByTestId("sea-identity-session").getByRole("button", { name: "Use saved identity", exact: true }).click();
    assert.equal((await exchange).ok(), true);
    const native = await context.request.get(fixture.site_origin + "/api/identity/sea/session");
    assert.equal(native.ok(), true); assert.equal((await native.json()).principal, fixture.expected.sea_public_key);
    const count = evaluations.length; await page.goto(fixture.site_origin);
    await until(() => evaluations.length > count && evaluations.at(-1).authenticated === true);
    assert.equal(evaluations.at(-1).cohort, original.cohort); assert.equal(evaluations.at(-1).variant, original.variant);
    cases.push({ name: "sea-signin-preserves-assignment", status: "passed" });
    await page.getByTestId("experiment-hero").getByRole("link", { name: "Explore the public feed", exact: true }).click();
    await until(() => events.some(e => e.event_type === "experiment.conversion.v2"));
    const conversion = events.find(e => e.event_type === "experiment.conversion.v2");
    assert.equal(conversion.assignment_hash, original.cohort); assert.equal(conversion.variant, original.variant);
    cases.push({ name: "feed-click-retains-original-attribution", status: "passed" });
    await Promise.allSettled([...pending]);
    // Only the separate CI telemetry verifier receives these pseudonymous IDs.
    // Never upload this private file or authentication material as an artifact.
    const file = await open(output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(JSON.stringify({ version: 1, events: events.slice(0, 32) })); } finally { await file.close(); }
    const previous = evaluations.length; await page.goto(fixture.site_origin);
    await until(() => evaluations.length > previous);
    assert.equal(evaluations.at(-1).cohort, original.cohort);
    cases.push({ name: "refresh-preserves-assignment", status: "passed" });
    status = "passed"; reason = undefined;
  } catch { status = fixture ? "failed" : "blocked"; process.exitCode = fixture ? 1 : 78; }
  finally {
    if (page && fixture) {
      // Withdraw only this disposable browser's consent, including its pending
      // outbox. Do not reset existing TEST accounts, flags or provider state.
      try {
        await page.goto(fixture.site_origin);
        const withdrawn = page.waitForResponse(response => response.url() === fixture.site_origin + "/api/experiments" &&
          response.request().method() === "POST" && response.request().postDataJSON()?.action === "consent");
        await page.getByRole("button", { name: "Turn off page experiments and delete pending events", exact: true }).click();
        const response = await withdrawn;
        assert.equal(response.ok(), true); assert.equal((await response.json()).consented, false);
      } catch { status = "failed"; reason = "private-consent-cleanup-failed"; process.exitCode = 1; }
    }
    await context?.close(); await browser?.close();
    report(status, reason);
  }
}
