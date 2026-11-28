import assert from "node:assert/strict";
import test from "node:test";

const config = {
  authorityEndpoint: "/api/squad/authority",
  statementEndpoint: "/api/squad/statement",
  sessionBase: "/api/identity/sea",
  origin: "https://s3r.ch",
  config: { keys: [] },
  squad: { forumId: "forum_fixture", owner: "owner.fixture", label: "Fixture" },
};

test("room authority config loader rejects stale pilot endpoints", async () => {
  const { loadRoomAuthorityConfig } = await import("./room-authority-config");
  const fetcher = async (url: string) => new Response(JSON.stringify({ config }), {
    status: url.endsWith("/api/squad/client-config") ? 200 : 404,
    headers: { "content-type": "application/json" },
  });
  const loaded = await loadRoomAuthorityConfig(fetcher as typeof fetch);
  assert.equal(loaded?.authorityEndpoint, "/api/squad/authority");
  assert.equal(loaded?.statementEndpoint, "/api/squad/statement");
});