import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ForumShell, type ForumTab } from "../components/ForumShell";

const props = { forum: { label: "Squad preview", href: "/feed/squad" }, header: "identity and alarm",
  sidebar: "vitals", controls: "roster filters", board: "board content", list: "list content", chat: "conversation", onTab: () => {} };
for (const tab of ["memory", "reports", "messages"] as const) test(`${tab} cannot mount shared or roster content`, () => {
  const forbidden = () => { throw Error("unavailable view mounted content"); };
  const html = renderToStaticMarkup(createElement(ForumShell, { ...props, tab,
    controls: createElement(forbidden), board: createElement(forbidden), list: createElement(forbidden) }));
  assert.match(html, /role="status"/); assert.doesNotMatch(html, /roster filters|board content|list content/);
});
test("template entries are disabled and only the existing forum is navigable", () => {
  const html = renderToStaticMarkup(createElement(ForumShell, { ...props, tab: "board" }));
  assert.equal((html.match(/disabled=""/g) ?? []).length, 5);
  assert.equal((html.match(/<a /g) ?? []).length, 1);
  assert.match(html, /aria-current="page"/); assert.match(html, /No source connected/);
});
for (const tab of ["board", "list"] as ForumTab[]) test(`${tab} renders the selected roster presentation`, () => {
  const html = renderToStaticMarkup(createElement(ForumShell, { ...props, tab }));
  assert.match(html, /roster filters/); assert.match(html, /conversation/);
  assert.ok(html.includes(tab === "list" ? "list content" : "board content"));
  assert.ok(!html.includes(tab === "list" ? "board content" : "list content"));
});
