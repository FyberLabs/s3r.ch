// Scheduled owner browser matrix only. Never preload authenticated storageState or bearer tokens.
import assert from "node:assert/strict";
import { loadStartupBrowserFixture, scheduledStartupBrowser } from "./startup-browser-fixture.mjs";
const cases = [];
function report(status, reason) { console.log(JSON.stringify({ schema_version: 1, status, ...(reason ? { reason } : {}), cases })); }
if (!scheduledStartupBrowser(process.env)) {
  report("blocked", "scheduled-infra-context-required"); process.exitCode = 78;
} else {
  let browser;
  try {
    let fixture;
    try { fixture = await loadStartupBrowserFixture(process.env.NIGHTLY_STARTUP_BROWSER_FIXTURE_FILE); }
    catch { report("blocked", "private-browser-fixture-unavailable"); process.exitCode = 78; }
    if (fixture) {
      const { chromium } = await import("playwright-core");
      browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
      const context = await browser.newContext();
      const page = await context.newPage(); page.setDefaultTimeout(30000);
      await page.goto(fixture.site_origin + "/feed");
      // Stage only this explicitly supplied existing key into a fresh isolated browser.
      // No init script runs on provider origins, and no shared TEST data is reset.
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
      async function login() {
        await page.goto(fixture.site_origin + "/feed");
        await panel.getByRole("link", { name: "Sign in with your linked organization account" }).click();
        for (const step of fixture.login.steps) {
          await page.waitForURL(url => url.origin === step.origin ||
            (url.origin === fixture.site_origin && url.searchParams.get("startup") === "linked"));
          if (new URL(page.url()).origin === fixture.site_origin) break;
          // Credentials are entered only at this step's explicit provider origin.
          assert.equal(new URL(page.url()).origin, step.origin);
          const target = page.locator(step.selector);
          if (step.action === "fill") await target.fill(fixture.login.credentials[step.credential]);
          else await target.click();
        }
        await page.waitForURL(url => url.origin === fixture.site_origin && url.searchParams.get("startup") === "linked");
        await panel.getByText("Connected existing identity", { exact: false }).waitFor();
        const view = await page.evaluate(async () => {
          const response = await fetch("/api/identity/startup/session", { cache: "no-store" });
          if (!response.ok) throw Error("Credential unavailable");
          return response.json();
        });
        for (const key of ["sea_public_key", "person_id", "tenant_id", "binding_sha256", "mapping_sha256"]) assert.equal(view.identity[key], fixture.expected[key]);
        assert.deepEqual(view.identity.organizations.map(row => row.id).sort(), [...fixture.expected.organization_ids].sort());
        assert.ok(!view.identity.organizations.some(row => row.id === fixture.negative_organization_id));
        const saved = await page.evaluate(async address => new Promise((resolve, reject) => {
          const request = indexedDB.open("s3rch-identity", 1);
          request.onerror = () => reject(Error("Key read failed"));
          request.onsuccess = () => {
            const db = request.result, tx = db.transaction("mesh-keys", "readonly"), row = tx.objectStore("mesh-keys").get(address);
            row.onsuccess = () => resolve(row.result); row.onerror = () => reject(Error("Key read failed")); tx.oncomplete = () => db.close();
          };
        }), fixture.sea_record.address);
        assert.deepEqual(saved, fixture.sea_record);
      }
      await login(); cases.push({ name: "linked-login-preserves-existing-sea", status: "passed" });
      const select = panel.getByRole("combobox", { name: "Organization" });
      await select.selectOption(fixture.expected.organization_ids[0]);
      assert.equal(await select.inputValue(), fixture.expected.organization_ids[0]);
      await select.evaluate((element, id) => {
        const option = document.createElement("option"); option.value = id; option.textContent = "foreign";
        element.append(option); element.value = id; element.dispatchEvent(new Event("change", { bubbles: true }));
      }, fixture.negative_organization_id);
      assert.notEqual(await select.inputValue(), fixture.negative_organization_id);
      cases.push({ name: "foreign-organization-selection-refused", status: "passed" });
      await panel.getByRole("button", { name: "Sign out linked account" }).click();
      await panel.getByRole("link", { name: "Sign in with your linked organization account" }).waitFor();
      await login(); cases.push({ name: "logout-relogin-preserves-existing-sea", status: "passed" });
      const seaSession = page.getByTestId("sea-identity-session");
      await seaSession.getByRole("button", { name: "Use saved identity", exact: true }).click();
      await seaSession.getByText("Identity session ready.", { exact: true }).waitFor();
      const feedSession = await page.evaluate(async () => {
        const response = await fetch("/api/identity/session", { cache: "no-store" });
        if (!response.ok) throw Error("Feed identity unavailable");
        return response.json();
      });
      assert.equal(feedSession.owner, fixture.expected.sea_public_key);
      await page.getByRole("button", { name: "Mine", exact: true }).click();
      const body = "Scheduled private feed ownership check";
      await page.getByRole("textbox", { name: "Body", exact: true }).fill(body);
      await page.getByRole("button", { name: "Post to Mine", exact: true }).click();
      await page.getByText("Saved.", { exact: true }).waitFor();
      await page.getByText(body, { exact: true }).waitFor();
      await page.getByRole("button", { name: "Public", exact: true }).click();
      await page.getByRole("button", { name: "Mine", exact: true }).click();
      await page.getByText(body, { exact: true }).waitFor();
      cases.push({ name: "sea-sign-in-post-mine", status: "passed" });
      // Mine is browser-local. Sign-out must remove the row; never share it.
      await seaSession.getByRole("button", { name: "Sign out identity", exact: true }).click();
      await seaSession.getByText("Identity session cleared.", { exact: true }).waitFor();
      await page.getByText(body, { exact: true }).waitFor({ state: "hidden" });
      cases.push({ name: "sea-sign-out-clears-mine", status: "passed" });
      report("passed");
    }
  } catch { report("failed", "startup-browser-contract-failed"); process.exitCode = 1; }
  finally { await browser?.close(); }
}
