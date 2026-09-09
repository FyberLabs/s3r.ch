import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  GOOGLE_STUN_URL,
  stunOnlyRtcOptions,
  type BrowserRtcOptions,
} from "./gun-webrtc";
import {
  ALLOCATE_EXPIRES_AT,
  ALLOCATE_OK_BODY,
  ALLOCATE_OK_NO_STUN,
} from "./turn-allocate.fixtures";
import { parseAllocateResponse } from "./turn-allocate";
import {
  REALLOCATE_LEAD_MS,
  TURN_ALLOCATE_PATH,
  applyRtcIceServers,
  fetchTurnAllocate,
  iceHasTurn,
  msUntilReallocate,
  rtcOptionsFromAllocation,
  startTurnIceRefresh,
  withGoogleStun,
} from "./turn-ice";

function helperSource(): string {
  return readFileSync(new URL("./turn-ice.ts", import.meta.url), "utf8");
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("browser allocate consume", () => {
  it("POSTs the same-origin hop and admits the fixture", async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const allocated = await fetchTurnAllocate(async (url, init) => {
      seen.push({ url: String(url), init });
      return jsonResponse(200, ALLOCATE_OK_BODY);
    });
    assert.equal(TURN_ALLOCATE_PATH, "/api/turn/allocate");
    assert.equal(seen[0].url, TURN_ALLOCATE_PATH);
    assert.equal(seen[0].init?.method, "POST");
    assert.equal(seen[0].init?.credentials, "same-origin");
    assert.deepEqual(allocated, parseAllocateResponse(ALLOCATE_OK_BODY));
    assert.equal(iceHasTurn(allocated?.iceServers ?? []), true);
  });

  it("fails soft to null on 401, 503, and network", async () => {
    assert.equal(
      await fetchTurnAllocate(async () => jsonResponse(401, { error: "unauthorized" })),
      null,
    );
    assert.equal(
      await fetchTurnAllocate(async () => jsonResponse(503, { error: "turn-unconfigured" })),
      null,
    );
    assert.equal(
      await fetchTurnAllocate(async () => {
        throw new Error("offline");
      }),
      null,
    );
  });

  it("does not write credentials to Gun or localStorage", () => {
    const src = helperSource();
    assert.equal(src.includes("localStorage"), true);
    assert.equal(src.includes("Do not put"), true);
    assert.equal(src.includes("gun.get"), false);
    assert.equal(src.includes("NEXT_PUBLIC_"), false);
  });

  it("keeps public / and /feed copy short — no TURN essay", () => {
    const home = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
    const feed = readFileSync(new URL("../app/feed/page.tsx", import.meta.url), "utf8");
    for (const src of [home, feed]) {
      assert.equal(src.includes("iceServers"), false);
      assert.equal(src.includes("allocate"), false);
      assert.equal(src.includes("coturn"), false);
      assert.equal(src.includes("PANOPTICON_"), false);
    }
    assert.equal(home.includes("Tagged posts and rooms."), true);
    assert.equal(feed.includes("Tagged posts and rooms."), true);
  });
});

describe("rtc options from allocate", () => {
  it("keeps STUN-only when allocate is null", () => {
    assert.deepEqual(rtcOptionsFromAllocation(null), stunOnlyRtcOptions());
    assert.equal(iceHasTurn(stunOnlyRtcOptions().iceServers), false);
  });

  it("passes allocate iceServers into rtc and keeps Google STUN", () => {
    const ok = parseAllocateResponse(ALLOCATE_OK_BODY);
    assert.ok(ok);
    const rtc = rtcOptionsFromAllocation(ok);
    assert.equal(iceHasTurn(rtc.iceServers), true);
    assert.ok(
      rtc.iceServers.some((server) =>
        JSON.stringify(server.urls).includes("stun:stun.l.google.com:19302"),
      ),
    );
    const noStun = parseAllocateResponse(ALLOCATE_OK_NO_STUN);
    assert.ok(noStun);
    const merged = withGoogleStun(noStun.iceServers);
    assert.deepEqual(merged[merged.length - 1], { urls: GOOGLE_STUN_URL });
  });

  it("mutates the same rtc object Gun closes over", () => {
    const rtc: BrowserRtcOptions = stunOnlyRtcOptions();
    const ok = parseAllocateResponse(ALLOCATE_OK_BODY);
    assert.ok(ok);
    applyRtcIceServers(rtc, ok.iceServers);
    assert.equal(iceHasTurn(rtc.iceServers), true);
    assert.equal(
      rtc.iceServers[0].username,
      ALLOCATE_OK_BODY.iceServers[0].username,
    );
  });
});

describe("re-allocate before expiresAt", () => {
  it("schedules the lead before expiry", () => {
    const exp = Date.parse(ALLOCATE_EXPIRES_AT);
    assert.equal(msUntilReallocate(ALLOCATE_EXPIRES_AT, exp - 90_000), 60_000);
    assert.equal(msUntilReallocate(ALLOCATE_EXPIRES_AT, exp - 10_000), 0);
    assert.equal(msUntilReallocate("nope", Date.now()), 0);
    assert.equal(REALLOCATE_LEAD_MS, 30_000);
  });

  it("applies a refresh onto the live rtc object", async () => {
    const rtc: BrowserRtcOptions = stunOnlyRtcOptions();
    const waits: number[] = [];
    const applied: string[] = [];
    let fire: (() => void) | undefined;
    const handle = startTurnIceRefresh({
      rtc,
      expiresAt: ALLOCATE_EXPIRES_AT,
      now: () => Date.parse(ALLOCATE_EXPIRES_AT) - 90_000,
      fetchAllocate: async () => parseAllocateResponse(ALLOCATE_OK_BODY),
      setTimeoutFn: ((fn: () => void, ms?: number) => {
        waits.push(ms ?? 0);
        fire = fn;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearTimeoutFn: (() => {}) as typeof clearTimeout,
      onApplied: (row) => applied.push(row.expiresAt),
    });
    assert.deepEqual(waits, [60_000]);
    assert.equal(iceHasTurn(rtc.iceServers), false);
    fire?.();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(iceHasTurn(rtc.iceServers), true);
    assert.deepEqual(applied, [ALLOCATE_EXPIRES_AT]);
    handle.stop();
  });
});
