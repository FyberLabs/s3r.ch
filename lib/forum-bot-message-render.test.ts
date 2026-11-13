import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ForumBotMessage } from "../components/ForumBotMessage";
import { type BotMessage } from "./forum-bot-protocol";
const id = "12345678-1234-1234-1234-123456789abc";
const render = (message: BotMessage, viewer = "user", action = true) => renderToStaticMarkup(createElement(ForumBotMessage,
  { message, author: "user", viewer, onPrepareCancel: action ? () => {} : undefined }));
test("task cancellation is offered only to the message author with a writable empty composer", () => {
  const task: BotMessage = ["task", id, id, id, id, 1700000000, null, 2];
  assert.match(render(task), /Task request/); assert.match(render(task), /Prepare cancellation/);
  assert.doesNotMatch(render(task, "other"), /<button/);
  assert.doesNotMatch(render(task, "user", false), /<button/);
});
test("reported status does not claim local completion or cancellation", () => {
  assert.match(render(["progress", id, id, 30]), /value="30" max="100"/);
  const cancelled = render(["cancel", id, id]);
  assert.match(cancelled, /does not confirm that active work stopped/);
  assert.doesNotMatch(cancelled, /<button/);
  const result = render(["result", id, id, "completed", id]);
  assert.match(result, /Reported outcome: completed/);
  assert.match(result, /Access must be checked/);
  assert.doesNotMatch(result, /href=|src=|<button/);
});

test("untrusted out-of-range deadlines do not crash task rendering", () => {
  assert.match(render(["task", id, id, id, id, Number.MAX_SAFE_INTEGER, null, 0]), /Invalid deadline/);
  assert.match(render(["task", id, id, id, id, 1700000000, null, 0]), /2023-11-14 22:13:20 UTC/);
});

test("approval reports display timing without creating permission controls", () => {
  const html = render(["approval", id, id, 1699999999, 1700000000]);
  assert.match(html, /Local approval reported/);
  assert.match(html, /historical report does not grant access/);
  assert.match(html, /2023-11-14 22:13:20 UTC/);
  assert.match(html, /Reported approval time<\/dt><dd>2023-11-14 22:13:19 UTC/);
  assert.doesNotMatch(html, /<button|href=|src=/);
  assert.match(render(["approval", id, id, 1, Number.MAX_SAFE_INTEGER]), /Invalid deadline/);
  assert.match(render(["approval", id, id, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER]), /Invalid approval time/);
});
