import test from "node:test";
import assert from "node:assert/strict";
import { GET, POST } from "../app/api/squad/pilot/[...path]/route";
test("unconfigured pilot routes stay disabled and invalid secret references fail without disclosure", async () => {
  const previous = process.env.S3RCH_SQUAD_PILOT;
  const request = new Request("https://s3r.ch/api/squad/pilot/health");
  try {
    delete process.env.S3RCH_SQUAD_PILOT;
    assert.equal((await GET(request, { params: Promise.resolve({ path: ["health"] }) })).status, 404);
    assert.equal((await POST(request, { params: Promise.resolve({ path: ["session", "challenge"] }) })).status, 404);
    process.env.S3RCH_SQUAD_PILOT = "private-value-not-json";
    for (const handler of [GET, POST]) {
      const response = await handler(request, { params: Promise.resolve({ path: ["health"] }) });
      assert.equal(response.status, 503); assert.equal(response.headers.get("cache-control"), "no-store");
      assert.ok(!(await response.text()).includes("private-value"));
    }
  } finally { if (previous === undefined) delete process.env.S3RCH_SQUAD_PILOT; else process.env.S3RCH_SQUAD_PILOT = previous; }
});
