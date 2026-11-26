import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readFeedTelemetry, summarizeFeedAttempt } from "./feed-telemetry";

const seededAt = "2026-11-20T12:00:00.000Z";
const now = Date.parse(seededAt) + 60_000;

test("feed attempts distinguish complete, partial, failed and absent refreshes", () => {
  const summarize = (sourcesOk: number, sourcesTried: number, error: string | null = null) =>
    summarizeFeedAttempt({ seededAt, sourcesOk, sourcesTried, error }, now);
  assert.deepEqual(summarize(2, 2), { status: "ok", attemptedAt: seededAt });
  assert.deepEqual(summarize(1, 2, "private upstream"), { status: "partial", attemptedAt: seededAt });
  assert.deepEqual(summarize(0, 2, "private upstream"), { status: "failed", attemptedAt: seededAt });
  assert.deepEqual(summarize(0, 0), { status: "absent", attemptedAt: null });
  assert.deepEqual(summarize(3, 2), { status: "absent", attemptedAt: null });
  assert.deepEqual(summarizeFeedAttempt({ seededAt, sourcesOk: 2, sourcesTried: 2 }, now - 120_000),
    { status: "absent", attemptedAt: null });
});

test("the published snapshot exports no contents or upstream error", (t) => {
  const root = mkdtempSync(join(tmpdir(), "s3rch-feed-telemetry-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "public", "feed-cache");
  mkdirSync(dir, { recursive: true });
  assert.deepEqual(readFeedTelemetry(root), { status: "absent", attemptedAt: null });
  const path = join(dir, "snapshot.json");
  const attemptedAt = "2020-01-01T00:00:00.000Z";
  writeFileSync(path, JSON.stringify({
    seededAt: attemptedAt, sourcesOk: 0, sourcesTried: 2, error: "private URL",
    items: [{ id: "item identifier", body: "previous generation" }],
  }));
  assert.deepEqual(readFeedTelemetry(root), { status: "failed", attemptedAt });
  writeFileSync(path, "{");
  assert.deepEqual(readFeedTelemetry(root), { status: "absent", attemptedAt: null });
});
