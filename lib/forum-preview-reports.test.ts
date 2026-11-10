import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ForumPreviewReports } from "../components/ForumPreviewReports";
import { PILOT_CHAT } from "./forum-squad-fixture";
import type { FeedItem } from "./feed-types";

test("preview report forwarding follows the current tagged row through each destination", () => {
  const report = PILOT_CHAT.find(row => row.tags.includes("report"))!;
  const ordinary = PILOT_CHAT.find(row => !row.tags.includes("report"))!;
  const shared = new Map<FeedItem, "Fleet" | "Command">();
  const render = (level: "Squad" | "Fleet" | "Command", chat = [report, ordinary]) => renderToStaticMarkup(
    createElement(ForumPreviewReports, { level, chat, shared, onToggle() {}, authorLabel: () => "Agent" }));
  assert.ok(render("Squad").includes(report.body));
  assert.ok(!render("Squad").includes(ordinary.body));
  assert.match(render("Fleet"), /No reports/);
  shared.set(report, "Fleet");
  assert.ok(render("Fleet").includes(report.body));
  assert.match(render("Command"), /No reports/);
  shared.set(report, "Command");
  assert.ok(render("Command").includes(report.body));
  assert.match(render("Command", [{ ...report, body: "Replacement" }]), /No reports/);
  assert.match(render("Fleet", []), /No reports/);
});
