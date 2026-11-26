// Scheduled owner browser matrix only. Never preload authenticated storageState or bearer tokens.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { loadStartupBrowserFixture, scheduledStartupBrowser, nightlyLoginDriver,
  nightlyLoginOrigin, testMemberOtp } from "./startup-browser-fixture.mjs";
const caseNames = [
  "linked-login-preserves-existing-sea",
  "foreign-organization-selection-refused",
  "logout-relogin-preserves-existing-sea",
  "sea-sign-in-post-mine",
  "sea-sign-out-clears-mine",
];
const cases = [];
function passCase() {
  cases.push({ name: caseNames[cases.length], status: "passed" });
}
function report(status, reason) { console.log(JSON.stringify({ schema_version: 1, status, ...(reason ? { reason } : {}), cases })); }
if (!scheduledStartupBrowser(process.env)) {
  report("blocked", "scheduled-infra-context-required"); process.exitCode = 78;
} else {
  let browser;
  let stage = "browser-launch";
  try {
    let fixture;
    try { fixture = await loadStartupBrowserFixture(process.env.NIGHTLY_STARTUP_BROWSER_FIXTURE_FILE); }
    catch { report("blocked", "private-browser-fixture-unavailable"); process.exitCode = 78; }
    if (fixture) {
      const { chromium } = await import("playwright-core");
      browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
      const context = await browser.newContext();
      const page = await context.newPage(); page.setDefaultTimeout(30000);
      async function openFeed() {
        stage = "feed-navigation";
        const response = await page.goto(fixture.site_origin + "/feed");
        assert.ok(response?.ok());
      }
      await openFeed();
      stage = "existing-key-fixture";
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
      const linkedAccount = panel.getByRole("link", { name: "Sign in with your linked organization account" });
      const hasFormAction = async (input, path) => input.evaluate((element, target) =>
        element.form?.method === "post" && element.form?.action && new URL(element.form.action).origin === target.origin &&
        new URL(element.form.action).pathname === target.path, { origin: nightlyLoginOrigin, path });
      let lastOtpWindow = -1;
      async function loginWithNightlyBroker() {
        stage = "linked-sign-in-control";
        const link = new URL(await linkedAccount.getAttribute("href"), fixture.site_origin);
        assert.equal(link.href, fixture.site_origin + "/api/identity/startup/start");
        link.searchParams.set("provider", "startup-nightly");
        stage = "broker-password-form";
        await page.goto(link.href);
        const upstream = "/realms/startup-nightly", downstream = "/realms/controlplane";
        const passwordForm = upstream + "/login-actions/authenticate";
        const password = page.locator("input#password");
        await page.waitForURL(url => url.origin === nightlyLoginOrigin &&
          [upstream + "/protocol/openid-connect/auth", passwordForm].includes(url.pathname));
        await password.waitFor();
        assert.ok(await hasFormAction(password, passwordForm));
        await page.locator("input#username").fill(fixture.login.credentials.username);
        await password.fill(fixture.login.credentials.password);
        await page.locator("#kc-login").click();
        stage = "broker-otp-form";
        const otpForm = downstream + "/login-actions/post-broker-login";
        const otp = page.locator("input#otp");
        await page.waitForURL(url => url.origin === nightlyLoginOrigin &&
          [downstream + "/broker/startup-nightly/endpoint", otpForm].includes(url.pathname));
        await otp.waitFor();
        assert.ok(await hasFormAction(otp, otpForm));
        const now = Date.now(), window = Math.floor(now / 30000), next = (window + 1) * 30000;
        if (window === lastOtpWindow || next - now < 2000) await delay(next - now + 250);
        const verificationTime = Date.now();
        lastOtpWindow = Math.floor(verificationTime / 30000);
        await otp.fill(testMemberOtp(fixture.login.credentials.otp_seed, verificationTime));
        await page.locator("#kc-login").click();
      }
      async function login() {
        await openFeed();
        stage = "linked-sign-in-control";
        if (fixture.login.driver === nightlyLoginDriver) await loginWithNightlyBroker();
        else await linkedAccount.click();
        stage = "provider-login-steps";
        for (const step of fixture.login.steps ?? []) {
          await page.waitForURL(url => url.origin === step.origin ||
            (url.origin === fixture.site_origin && url.searchParams.get("startup") === "linked"));
          if (new URL(page.url()).origin === fixture.site_origin) break;
          // Credentials are entered only at this step's explicit provider origin.
          assert.equal(new URL(page.url()).origin, step.origin);
          const target = page.locator(step.selector);
          if (step.action === "fill") await target.fill(fixture.login.credentials[step.credential]);
          else await target.click();
        }
        stage = "linked-callback";
        await page.waitForURL(url => url.origin === fixture.site_origin && url.searchParams.get("startup") === "linked");
        stage = "linked-identity-panel";
        await panel.getByText("Connected existing identity", { exact: false }).waitFor();
        stage = "linked-session-contract";
        const view = await page.evaluate(async () => {
          const response = await fetch("/api/identity/startup/session", { cache: "no-store" });
          if (!response.ok) throw Error("Credential unavailable");
          return response.json();
        });
        for (const key of ["sea_public_key", "person_id", "tenant_id", "binding_sha256", "mapping_sha256"]) assert.equal(view.identity[key], fixture.expected[key]);
        assert.deepEqual(view.identity.organizations.map(row => row.id).sort(), [...fixture.expected.organization_ids].sort());
        assert.ok(!view.identity.organizations.some(row => row.id === fixture.negative_organization_id));
        stage = "existing-key-preservation";
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
      await login();
      passCase();
      stage = "organization-selection";
      const select = panel.getByRole("combobox", { name: "Organization" });
      if (fixture.expected.organization_ids.length === 0) {
        assert.equal(await select.count(), 0);
      } else {
        await select.selectOption(fixture.expected.organization_ids[0]);
        assert.equal(await select.inputValue(), fixture.expected.organization_ids[0]);
        await select.evaluate((element, id) => {
          const option = document.createElement("option"); option.value = id; option.textContent = "foreign";
          element.append(option); element.value = id; element.dispatchEvent(new Event("change", { bubbles: true }));
        }, fixture.negative_organization_id);
        assert.notEqual(await select.inputValue(), fixture.negative_organization_id);
      }
      passCase();
      stage = "linked-logout";
      await panel.getByRole("button", { name: "Sign out linked account" }).click();
      await linkedAccount.waitFor();
      await login();
      passCase();
      stage = "sea-sign-in";
      const seaSession = page.getByTestId("sea-identity-session");
      await seaSession.getByRole("button", { name: "Use saved identity", exact: true }).click();
      await seaSession.getByText("Identity session ready.", { exact: true }).waitFor();
      const feedSession = await page.evaluate(async () => {
        const response = await fetch("/api/identity/session", { cache: "no-store" });
        if (!response.ok) throw Error("Feed identity unavailable");
        return response.json();
      });
      assert.equal(feedSession.owner, fixture.expected.sea_public_key);
      stage = "private-feed";
      const home = await page.goto(fixture.site_origin + "/");
      assert.ok(home?.ok());
      const hero = page.getByTestId("experiment-hero");
      await hero.getByRole("heading", { name: "Welcome back.", exact: true }).waitFor();
      await hero.getByText("You’re signed in.", { exact: false }).waitFor();
      await hero.getByRole("link", { name: "View your session", exact: true }).waitFor();
      assert.equal(await hero.getByRole("link", { name: "Join s3r.ch", exact: true }).count(), 0);
      await openFeed();
      stage = "private-feed";
      await page.getByRole("button", { name: "Mine", exact: true }).click();
      const body = "Scheduled private feed ownership check";
      await page.getByRole("textbox", { name: "Body", exact: true }).fill(body);
      await page.getByRole("button", { name: "Post to Mine", exact: true }).click();
      await page.getByText("Saved.", { exact: true }).waitFor();
      await page.getByText(body, { exact: true }).waitFor();
      await page.getByRole("button", { name: "Public", exact: true }).click();
      await page.getByRole("button", { name: "Mine", exact: true }).click();
      await page.getByText(body, { exact: true }).waitFor();
      await seaSession.getByRole("button", { name: "Refresh identity session", exact: true }).click();
      await seaSession.getByText("Identity session ready.", { exact: true }).waitFor();
      await page.getByText(body, { exact: true }).waitFor();
      passCase();
      stage = "private-room-cleanup";
      const roomTitle = "Scheduled private room ownership check";
      await page.getByRole("textbox", { name: "New room", exact: true }).fill(roomTitle);
      await page.getByRole("button", { name: "New room", exact: true }).click();
      await page.getByRole("button", { name: roomTitle, exact: true }).waitFor();
      await page.getByRole("textbox", { name: "Body", exact: true }).fill("Private draft from the previous session");
      // Mine is browser-local. Sign-out must remove rows, rooms and drafts; never share them.
      await seaSession.getByRole("button", { name: "Sign out identity", exact: true }).click();
      await seaSession.getByText("Identity session cleared.", { exact: true }).waitFor();
      await page.getByText(body, { exact: true }).waitFor({ state: "hidden" });
      await page.getByRole("button", { name: roomTitle, exact: true }).waitFor({ state: "hidden" });
      await seaSession.getByRole("button", { name: "Use saved identity", exact: true }).click();
      await seaSession.getByText("Identity session ready.", { exact: true }).waitFor();
      await page.getByRole("textbox", { name: "Body", exact: true }).waitFor();
      assert.equal(await page.getByRole("textbox", { name: "Body", exact: true }).inputValue(), "");
      assert.equal(await page.getByText(body, { exact: true }).count(), 0);
      assert.equal(await page.getByRole("button", { name: roomTitle, exact: true }).count(), 0);
      passCase();
      report("passed");
    }
  } catch {
    cases.push({ name: caseNames[cases.length], status: "failed" });
    report("failed", stage);
    process.exitCode = 1;
  }
  finally { await browser?.close(); }
}
