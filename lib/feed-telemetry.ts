import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

type FeedStatus = "ok" | "partial" | "failed" | "absent";
type FeedTelemetry = { status: FeedStatus; attemptedAt: string | null };

const absent: FeedTelemetry = { status: "absent", attemptedAt: null };
const snapshotLimit = 8 * 1024 * 1024;

export function summarizeFeedAttempt(snapshot: unknown, now = Date.now()): FeedTelemetry {
  if (!snapshot || typeof snapshot !== "object") return absent;
  const { seededAt, sourcesOk, sourcesTried, error } = snapshot as Record<string, unknown>;
  if (typeof seededAt !== "string" || typeof sourcesOk !== "number" ||
      typeof sourcesTried !== "number" || !Number.isSafeInteger(sourcesOk) ||
      !Number.isSafeInteger(sourcesTried) || sourcesOk < 0 ||
      sourcesTried <= 0 || sourcesOk > sourcesTried) return absent;
  const attemptedAt = Date.parse(seededAt);
  if (!Number.isFinite(attemptedAt) || attemptedAt <= 0 || attemptedAt > now) return absent;

  return {
    status: sourcesOk === 0 ? "failed" : sourcesOk < sourcesTried || error ? "partial" : "ok",
    attemptedAt: new Date(attemptedAt).toISOString(),
  };
}

// The publisher replaces this file by rename. Read one complete generation
// and export only its attempt metadata, even when it contains retained items.
export function readFeedTelemetry(root = process.cwd()): FeedTelemetry {
  try {
    const snapshot = openSync(join(root, "public", "feed-cache", "snapshot.json"), "r");
    try {
      const info = fstatSync(snapshot);
      if (!info.isFile() || info.size > snapshotLimit) return absent;
      const bytes = Buffer.alloc(info.size + 1);
      let used = 0;
      while (used < bytes.length) {
        const read = readSync(snapshot, bytes, used, bytes.length - used, null);
        if (read === 0) break;
        used += read;
      }
      if (used !== info.size) return absent;
      return summarizeFeedAttempt(JSON.parse(bytes.subarray(0, used).toString("utf8")));
    } finally {
      closeSync(snapshot);
    }
  } catch {
    return absent;
  }
}

// Health is publicly reachable. Coalesce repeated requests for the same local
// snapshot so health traffic cannot force a full file read on every request.
let held: { until: number; value: FeedTelemetry } | undefined;
export function publicFeedTelemetry(): FeedTelemetry {
  const now = performance.now();
  if (held && now < held.until) return held.value;
  const value = readFeedTelemetry();
  held = { value, until: now + 15_000 };
  return value;
}
