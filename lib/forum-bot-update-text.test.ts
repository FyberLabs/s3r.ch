import assert from "node:assert/strict";
import test from "node:test";
import { p256 } from "@noble/curves/nist.js";
import { encodeBotMessage, parseBotMessage, type BotUpdateMessage } from "./forum-bot-protocol";
import { validateBotUpdateText } from "./forum-bot-update-text";

const tenant = "812524e6-7e7d-4a3a-89f0-220007d7147e";
const task = "9ca138f7-8759-4348-b053-3ccc76287012";
const handle = "8b43161e-62e7-44fb-bc30-4337a39b6645";
const binding = { tenant, task, handles: [handle] };

test("bounded task update round trips without execution fields", () => {
  const text = validateBotUpdateText("a".repeat(180), binding);
  const message: BotUpdateMessage = ["update", tenant, task, text];
  assert.deepEqual(parseBotMessage(encodeBotMessage(message)), message);
  assert.throws(() => validateBotUpdateText("a".repeat(181), binding));
  assert.throws(() => encodeBotMessage(["update", tenant, task, "a".repeat(181)]));
  assert.throws(() => validateBotUpdateText('"'.repeat(180), binding));
});

test("task update validation refuses private handles, keys and nested commands", () => {
  const pub = p256.getPublicKey(Buffer.alloc(32, 17), false);
  const principal = Buffer.from(pub.slice(1, 33)).toString("base64url") + "." +
    Buffer.from(pub.slice(33)).toString("base64url");
  for (const text of [
    " Pending",
    `private handle: ${handle}`,
    "visor:v1:[]",
    '{"steps":[]}',
    '["result", "completed"]',
    '{"epriv":"test"}',
    "https://user:password@example.invalid",
    `Author: ${principal}`,
  ]) {
    assert.throws(() => validateBotUpdateText(text, binding), text);
  }
});
