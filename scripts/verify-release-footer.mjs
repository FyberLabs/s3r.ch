import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

export const packageVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

function releaseLabel(version, revision) {
  assert.match(version, /^[0-9]+\.[0-9]+\.[0-9]+$/);
  assert.match(revision, /^[0-9a-f]{40}$/);
  return `Version ${version} · Build ${revision.slice(0, 12)}`;
}

export function assertReleaseFooter(html, version, revision) {
  const expected = releaseLabel(version, revision);
  const markup = html.replace(/<!--[^]*?-->|<script\b[^>]*>[^]*?<\/script>/gi, "");
  const footers = markup.matchAll(/<footer\b[^>]*>([^]*?)<\/footer>/gi);
  for (const [, footer] of footers) {
    for (const [, paragraph] of footer.matchAll(/<p\b[^>]*>([^<]*)<\/p>/gi)) {
      if (paragraph.trim() === expected) return expected;
    }
  }
  assert.fail(`The footer did not render ${expected}.`);
}

async function verifyPublicTestFooter(revision) {
  const expected = releaseLabel(packageVersion, revision);
  const origin = "https://test.s3r.ch";
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const options = { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(8000) };
      const [page, version] = await Promise.all([
        fetch(`${origin}/?footer-check=${revision}`, options),
        fetch(`${origin}/api/version`, options),
      ]);
      assert.equal(page.status, 200);
      assert.equal(version.status, 200);
      assert.equal((await version.json()).revision, revision);
      assertReleaseFooter(await page.text(), packageVersion, revision);
      console.log(`Verified public TEST footer ${expected} (revision ${revision}).`);
      return;
    } catch {
      await delay(3000);
    }
  }
  assert.fail(`The public TEST homepage did not show ${expected} with origin revision ${revision}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  verifyPublicTestFooter(process.argv[2] ?? "").catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
