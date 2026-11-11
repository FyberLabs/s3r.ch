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
  "../app/layout.tsx",
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
  "../components/ForumHierarchyPreview.tsx",
  "../lib/features.ts",
  "../public/llms.txt",
  "../public/llms-full.txt",
  "../README.md",
  "../docs/deployment.md",
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
      assert.equal(src.includes("test mode"), false, path);
      assert.equal(src.includes("soft-opening"), false, path);
      assert.equal(src.includes("soft opening"), false, path);
      assert.equal(src.includes("nothing is charged"), false, path);
      assert.equal(src.includes("wallet owns"), false, path);
      assert.equal(src.includes("held for training"), false, path);
      assert.equal(src.includes("train on"), false, path);
      assert.equal(src.includes("deleted public posts are not kept"), false, path);
      assert.equal(/\bbeta\b/.test(src), false, path);
      assert.equal(/\bdemo\b/.test(src), false, path);
      assert.equal(src.includes("siri"), false, path);
      assert.equal(src.includes("gemini"), false, path);
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
    const layout = read("../app/layout.tsx");
    const agents = read("../public/llms.txt");
    assert.equal(home.includes("IdentityBar"), true);
    assert.equal(home.includes('href="#sign-in"'), true);
    assert.equal(home.includes('href="/feed"'), true);
    assert.equal(home.includes("Public feeds"), true);
    assert.equal(home.includes("quiet"), true);
    assert.equal(home.includes("The social network and collaborative workspace for humans and AI."), true);
    assert.equal(home.includes("What you can do today"), true);
    assert.equal(home.includes("Work and media"), true);
    assert.equal(home.includes("s3r.ch utilizes public posts to improve services."), true);
    assert.equal(home.includes("A post you delete on s3r.ch is removed."), true);
    assert.equal(home.includes("Deleted public posts are not kept."), false);
    assert.equal(agents.includes("ghcr.io/fyberlabs/s3r.ch:test"), true);
    assert.equal(agents.includes("ghcr.io/fyberlabs/s3r.ch:1.4"), true);
    assert.equal(agents.includes("Pin production with a digest"), false);
    assert.equal(agents.includes("https://github.com/FyberLabs/s3r.ch/issues/296"), true);
    assert.equal(layout.includes("The social network and collaborative workspace for humans and AI."), true);
    assert.equal(agents.includes("x-s3rch-forum-token"), true);
    assert.equal(agents.includes("https://github.com/FyberLabs/s3r.ch"), true);
    assert.equal(preview.includes('"/feed-cache/snapshot.json"'), true);
  });

  it("does not date a coming-soon claim or call a v1 item available now", () => {
    const files = [...new Set(marketing)];
    const v1Items = [
      "meetings",
      "live streams",
      "streamer chat",
      "video posts",
      "audio posts",
      "image posts",
      "meme editor",
      "game sessions",
      "memory map",
      "marketing campaigns",
      "business direction",
      "brand assets",
      "hiring",
      "contracting",
    ];
    const datedComing =
      /\bcoming(?:\s+soon|\s+next|\s+in\s+v1)\b[^.!?\n]{0,180}\b(20\d{2}|q[1-4]\b|january|february|march|april|june|july|august|september|october|november|december)\b/i;
    for (const path of files) {
      const src = read(path);
      const lower = src.toLowerCase();
      assert.equal(/\bcoming soon\b/i.test(src), false, path);
      assert.equal(datedComing.test(src), false, `${path} dates a coming claim`);
      const offeredNow = lower.replaceAll("not available now", "");
      assert.equal(offeredNow.includes("available now"), false, path);
      for (const item of v1Items) {
        let from = 0;
        while (from < lower.length) {
          const at = lower.indexOf(item, from);
          if (at < 0) break;
          const window = lower.slice(Math.max(0, at - 180), at + item.length + 180);
          assert.equal(
            window.replaceAll("not available now", "").includes("available now"),
            false,
            `${path} calls ${item} available now`,
          );
          from = at + item.length;
        }
      }
    }

    const visitor = files.filter((path) => path.includes("/app/"));
    for (const path of visitor) {
      const src = read(path);
      for (let issue = 300; issue <= 313; issue += 1) {
        assert.equal(src.includes(`/issues/${issue}`), false, `${path} links #${issue}`);
      }
    }

    const full = read("../public/llms-full.txt");
    const short = read("../public/llms.txt");
    const roadmap = read("../docs/ROADMAP-v1.md");
    for (let issue = 300; issue <= 313; issue += 1) {
      const url = `https://github.com/FyberLabs/s3r.ch/issues/${issue}`;
      assert.equal(full.includes(url), true, `llms-full.txt #${issue}`);
      assert.equal(roadmap.includes(url), true, `ROADMAP-v1.md #${issue}`);
      assert.equal(short.includes(`/issues/${issue}`), false, `llms.txt #${issue}`);
    }
    assert.equal(short.includes("https://github.com/FyberLabs/s3r.ch/issues/296"), true);
    assert.equal(full.includes("https://github.com/FyberLabs/s3r.ch/issues/296"), true);

    const social = read("../app/features/social/page.tsx");
    assert.equal(social.includes("Meetings, live streams, streamer chat, and video posts."), true);
    assert.equal(social.includes("A full search engine comes later."), true);
    const workspace = read("../app/features/workspace/page.tsx");
    assert.equal(workspace.includes("Coming in v1"), true);
    assert.equal(workspace.includes("s3r.ch utilizes public posts to improve services."), true);
    assert.equal(read("../lib/features.ts").includes('href: "/features/workspace"'), true);
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
