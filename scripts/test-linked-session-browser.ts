/** Scheduled isolated browser/HTTP admission contract; no deployed identity. */
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { linkedSessionFixture } from "./fixtures/linked-session";
import { createSeaSessionHandlers } from "../lib/identity/sea-session-http";
const names = ["wallet-linked-session", "oidc-linked-session", "replayed-proof-refused", "revoked-link-refused", "stale-source-refused", "missing-source-refused"];
const cases = names.map(name => ({ name, status: "blocked", reason: "not-run" }));
const report = (status: string, reason?: string) => console.log(JSON.stringify({ status, ...(reason ? { reason } : {}), cases }));
if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_EVENT_NAME !== "schedule") {
  report("blocked", "scheduled-ci-required"); process.exit(1);
}
async function main() {
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    for (const row of cases) {
      const fixture = await linkedSessionFixture(row.name === "oidc-linked-session" ? "oidc" : "wallet");
      const origin = "https://s3r.ch", handlers = createSeaSessionHandlers({ origin, sessions: fixture.sessions });
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        let unexpected = false;
        await context.route("**/*", async route => {
          const req = route.request(), url = new URL(req.url());
          if (url.origin !== origin) { unexpected = true; await route.abort(); return; }
          if (url.pathname === "/") { await route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Isolated linked admission</title>" }); return; }
          const request = new Request(req.url(), { method: req.method(), headers: await req.allHeaders(), body: req.postData() ?? undefined });
          let response: Response;
          if (url.pathname === "/fixture/proof") {
            const { challenge } = await request.json();
            response = Response.json(await fixture.proof(challenge));
          } else if (url.pathname === "/fixture/session") response = Response.json(await handlers.authenticate(request));
          else if (url.pathname.endsWith("/linked-challenge")) response = await handlers["linked-challenge"](request);
          else if (url.pathname.endsWith("/linked-exchange")) response = await handlers["linked-exchange"](request);
          else { unexpected = true; await route.abort(); return; }
          const headers = Object.fromEntries(response.headers);
          const cookies = response.headers.getSetCookie();
          if (cookies.length) headers["set-cookie"] = cookies.join("\n");
          await route.fulfill({ status: response.status, headers, body: await response.text() });
        });
        await page.goto(origin);
        const prepared = await page.evaluate(async credential => {
          const response = await fetch("/api/identity/sea/linked-challenge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credential }) });
          if (response.status !== 200) throw Error("challenge-refused");
          const { challenge } = await response.json();
          const proof = await (await fetch("/fixture/proof", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challenge }) })).json();
          return { challenge, proof };
        }, fixture.credential);
        if (row.name === "revoked-link-refused") fixture.revoke();
        if (row.name === "stale-source-refused") fixture.stale();
        if (row.name === "missing-source-refused") fixture.unavailable();
        const exchange = () => page.evaluate(async body => {
          const result = await fetch("/api/identity/sea/linked-exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
          const session = await (await fetch("/fixture/session")).json();
          return { status: result.status, session };
        }, prepared);
        const first = await exchange();
        if (row.name.endsWith("linked-session") || row.name === "replayed-proof-refused") {
          assert.equal(first.status, 200); assert.deepEqual(first.session, { key: fixture.principal });
          if (row.name === "replayed-proof-refused") {
            // Restore the bound challenge cookie to exercise server replay storage,
            // rather than stopping at the normally cleared cookie.
            await context.addCookies([{ name: "__Host-s3rch-squad-challenge", value: prepared.challenge, domain: "s3r.ch", path: "/", secure: true, httpOnly: true, sameSite: "Strict" }]);
            assert.equal((await exchange()).status, 403);
          }
        } else { assert.equal(first.status, 403); assert.equal(first.session, null); }
        assert.equal(unexpected, false);
        row.status = "passed"; row.reason = "verified";
      } catch { row.status = "failed"; row.reason = "admission-contract-failed"; throw Error(row.reason); }
      finally { await context.close(); }
    }
    report("passed");
  } catch { report(browser ? "failed" : "blocked", browser ? "admission-contract-failed" : "browser-unavailable"); process.exitCode = 1; }
  finally { await browser?.close(); }
}
void main();
