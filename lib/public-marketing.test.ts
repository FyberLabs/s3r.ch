import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { describe, it } from "node:test";

function read(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(new URL(dir, import.meta.url))) {
    const rel = `${dir}/${name}`;
    const full = new URL(rel, import.meta.url);
    if (statSync(full).isDirectory()) out.push(...walk(rel));
    else out.push(rel);
  }
  return out;
}

const marketing = [
  "../app/page.tsx",
  "../app/feed/page.tsx",
  "../app/feed/squad/page.tsx",
  "../app/forum/page.tsx",
  "../components/SiteHeader.tsx",
  "../components/SiteFooter.tsx",
  "../components/PublicFeedPreview.tsx",
  "../components/FeatureArticle.tsx",
  "../components/FeatureCards.tsx",
  "../components/SquadForum.tsx",
  "../components/SquadDelegationControls.tsx",
  "../lib/features.ts",
  ...walk("../app/features"),
];

describe("public marketing copy", () => {
  it("keeps Tennessee Windage and lab framing off the new pages", () => {
    const files = [...new Set(marketing)];
    for (const path of files) {
      const src = read(path).toLowerCase();
      assert.equal(src.includes("tennessee"), false, path);
      assert.equal(src.includes("lab feed"), false, path);
      assert.equal(src.includes("local demonstration"), false, path);
      assert.equal(src.includes("sample board"), false, path);
      assert.equal(src.includes("panopticon"), false, path);
      assert.equal(src.includes("lightiff"), false, path);
      assert.equal(src.includes("path a"), false, path);
      assert.equal(src.includes("path b"), false, path);
    }
  });

  it("points the header at Features and keeps Forum and Squad off the top nav", () => {
    const header = read("../components/SiteHeader.tsx");
    assert.equal(header.includes('href="/features"'), true);
    assert.equal(header.includes('href="/forum"'), false);
    assert.equal(header.includes('href="/feed/squad"'), false);
  });

  it("puts real sign-in and the public snapshot on the home page", () => {
    const home = read("../app/page.tsx");
    const preview = read("../components/PublicFeedPreview.tsx");
    assert.equal(home.includes("IdentityBar"), true);
    assert.equal(home.includes('href="#sign-in"'), true);
    assert.equal(home.includes('href="/feed"'), true);
    assert.equal(home.includes("Public feeds"), true);
    assert.equal(home.includes("quiet"), true);
    assert.equal(preview.includes('"/api/feed"'), true);
  });

  it("keeps the squad browser-only boundary in the smoke check and the board", () => {
    const smoke = read("../scripts/smoke-standalone.sh");
    const board = read("../components/SquadForum.tsx");
    assert.equal(smoke.includes("This board stays in this browser"), true);
    assert.equal(smoke.includes("local demonstration"), false);
    assert.equal(board.includes("This board stays in this browser until mesh publish."), true);
    assert.equal(board.includes("sample board"), false);
  });
});
