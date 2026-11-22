import assert from "node:assert/strict";
import test from "node:test";
import { roomWebhookCallback } from "./room-webhook-callback";

test("the webhook callback stays on the authorized origin and fixed receiver path", () => {
  assert.equal(roomWebhookCallback("https://test.s3r.ch"), "https://test.s3r.ch/api/rooms/webhooks/receive");
  assert.equal(roomWebhookCallback("https://s3r.ch"), "https://s3r.ch/api/rooms/webhooks/receive");
  for (const origin of ["http://test.s3r.ch", "https://s3r.ch:8443", "https://s3r.ch/other",
    "https://s3r.ch.example.test", "https://s3r.ch@other.example.test"]) {
    assert.equal(roomWebhookCallback(origin), null);
  }
});
