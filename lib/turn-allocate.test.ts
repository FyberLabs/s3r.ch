import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  ALLOCATE_BAD_EXPIRES,
  ALLOCATE_MISSING_CREDENTIAL,
  ALLOCATE_OK_BODY,
  ALLOCATE_OK_NO_STUN,
  ALLOCATE_PRIVATE_TURN,
  HOP_ENV,
} from "./turn-allocate.fixtures";
import {
  DEFAULT_CLIENT_HINT,
  ENV_API_KEY,
  ENV_TENANT_ID,
  ENV_TURN_BASE,
  allocateHopHeaders,
  allocateRequestBody,
  hopPanopticonAllocate,
  iceServerHasTurn,
  isPublicIceUrl,
  panopticonAllocateUrl,
  parseAllocateResponse,
  readTurnAllocateEnv,
  sanitizeClientHint,
  sessionGatedAllocate,
} from "./turn-allocate";

function helperSource(): string {
  return readFileSync(new URL("./turn-allocate.ts", import.meta.url), "utf8");
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("readTurnAllocateEnv", () => {
  it("is null when any of the three server env names is empty", () => {
    assert.equal(readTurnAllocateEnv({}), null);
    assert.equal(
      readTurnAllocateEnv({
        ...HOP_ENV,
        PANOPTICON_TURN_BASE: "",
      }),
      null,
    );
    assert.equal(
      readTurnAllocateEnv({
        ...HOP_ENV,
        PANOPTICON_API_KEY: "  ",
      }),
      null,
    );
    assert.equal(
      readTurnAllocateEnv({
        ...HOP_ENV,
        PANOPTICON_TURN_BASE: "ftp://turn.example.com",
      }),
      null,
    );
  });

  it("accepts http(s) lab and product bases, including localhost", () => {
    const cfg = readTurnAllocateEnv(HOP_ENV);
    assert.deepEqual(cfg, {
      base: "https://api.test.hyperme.sh",
      tenantId: HOP_ENV.PANOPTICON_TENANT_ID,
      apiKey: HOP_ENV.PANOPTICON_API_KEY,
    });
    const local = readTurnAllocateEnv({
      ...HOP_ENV,
      PANOPTICON_TURN_BASE: "http://localhost:8012/",
    });
    assert.equal(local?.base, "http://localhost:8012");
    assert.equal(ENV_TURN_BASE, "PANOPTICON_TURN_BASE");
    assert.equal(ENV_TENANT_ID, "PANOPTICON_TENANT_ID");
    assert.equal(ENV_API_KEY, "PANOPTICON_API_KEY");
  });
});

describe("panopticonAllocateUrl", () => {
  it("joins the locked path A URI from origin or /api/v1 prefix", () => {
    assert.equal(
      panopticonAllocateUrl("https://api.test.hyperme.sh"),
      "https://api.test.hyperme.sh/api/v1/turn/allocate",
    );
    assert.equal(
      panopticonAllocateUrl("http://localhost:8012/api/v1"),
      "http://localhost:8012/api/v1/turn/allocate",
    );
    assert.equal(
      panopticonAllocateUrl("https://api.test.hyperme.sh/api/v1/turn"),
      "https://api.test.hyperme.sh/api/v1/turn/allocate",
    );
    assert.equal(
      panopticonAllocateUrl("https://api.test.hyperme.sh/api/v1/turn/allocate"),
      "https://api.test.hyperme.sh/api/v1/turn/allocate",
    );
  });
});

describe("allocate hop headers and hint", () => {
  it("sends X-Tenant-ID + X-Api-Key and never NEXT_PUBLIC", () => {
    const cfg = readTurnAllocateEnv(HOP_ENV);
    assert.ok(cfg);
    const headers = allocateHopHeaders(cfg);
    assert.equal(headers["X-Tenant-ID"], HOP_ENV.PANOPTICON_TENANT_ID);
    assert.equal(headers["X-Api-Key"], HOP_ENV.PANOPTICON_API_KEY);
    assert.equal("Authorization" in headers, false);
    const src = helperSource();
    assert.equal(src.includes("NEXT_PUBLIC_TURN"), false);
    assert.equal(src.includes("Never NEXT_PUBLIC_*"), true);
    assert.equal(src.includes("localStorage"), true);
    assert.equal(src.includes("Never Gun"), true);
  });

  it("sanitizes clientHint to the allocate username charset", () => {
    assert.equal(sanitizeClientHint("s3rch-peer"), "s3rch-peer");
    assert.equal(
      sanitizeClientHint("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"),
      "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    );
    assert.equal(sanitizeClientHint("bad hint!"), "badhint");
    assert.equal(sanitizeClientHint(""), DEFAULT_CLIENT_HINT);
    assert.deepEqual(allocateRequestBody("s3rch-peer"), {
      ttlSec: 300,
      clientHint: "s3rch-peer",
    });
  });
});

describe("parseAllocateResponse fixtures", () => {
  it("admits the integrator-doc JSON", () => {
    const parsed = parseAllocateResponse(ALLOCATE_OK_BODY);
    assert.ok(parsed);
    assert.equal(parsed.expiresAt, ALLOCATE_OK_BODY.expiresAt);
    assert.equal(iceServerHasTurn(parsed.iceServers[0]), true);
    assert.equal(isPublicIceUrl("turn:turn.example.com:3478"), true);
    assert.equal(isPublicIceUrl("turns:turn.example.com:443"), true);
    assert.equal(isPublicIceUrl("stun:stun.l.google.com:19302"), true);
  });

  it("rejects private relay, missing TURN creds, and bad expiresAt", () => {
    assert.equal(parseAllocateResponse(ALLOCATE_PRIVATE_TURN), null);
    assert.equal(parseAllocateResponse(ALLOCATE_MISSING_CREDENTIAL), null);
    assert.equal(parseAllocateResponse(ALLOCATE_BAD_EXPIRES), null);
    assert.equal(parseAllocateResponse({ iceServers: [] }), null);
    assert.equal(isPublicIceUrl("turn:10.0.0.8:3478"), false);
    assert.equal(isPublicIceUrl("turn:192.168.1.9:3478"), false);
    assert.equal(isPublicIceUrl("turn:100.64.1.2:3478"), false);
    assert.equal(isPublicIceUrl("turn:localhost:3478"), false);
    assert.equal(isPublicIceUrl("turn:relay.ts.net:3478"), false);
    assert.equal(parseAllocateResponse(ALLOCATE_OK_NO_STUN)?.iceServers.length, 1);
  });
});

describe("sessionGatedAllocate", () => {
  it("is 401 without a SIWE session", async () => {
    const result = await sessionGatedAllocate({
      sessionAddress: null,
      env: HOP_ENV,
    });
    assert.equal(result.status, 401);
    assert.deepEqual(result.body, { error: "unauthorized" });
  });

  it("is 503 when env is empty (STUN-only)", async () => {
    const result = await sessionGatedAllocate({
      sessionAddress: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      env: {},
    });
    assert.equal(result.status, 503);
    assert.deepEqual(result.body, { error: "turn-unconfigured" });
  });

  it("hops POST allocate and returns { iceServers, expiresAt }", async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const result = await sessionGatedAllocate({
      sessionAddress: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      env: HOP_ENV,
      fetchImpl: async (url, init) => {
        seen.push({ url: String(url), init });
        return jsonResponse(200, ALLOCATE_OK_BODY);
      },
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, parseAllocateResponse(ALLOCATE_OK_BODY));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "https://api.test.hyperme.sh/api/v1/turn/allocate");
    assert.equal(seen[0].init?.method, "POST");
    const headers = seen[0].init?.headers as Record<string, string>;
    assert.equal(headers["X-Tenant-ID"], HOP_ENV.PANOPTICON_TENANT_ID);
    assert.equal(headers["X-Api-Key"], HOP_ENV.PANOPTICON_API_KEY);
    const body = JSON.parse(String(seen[0].init?.body)) as {
      ttlSec: number;
      clientHint: string;
    };
    assert.equal(body.ttlSec, 300);
    assert.equal(body.clientHint, "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
  });

  it("fails soft on 401, 503, network, and unparseable JSON", async () => {
    const cases: Array<() => Promise<Response>> = [
      async () => jsonResponse(401, { error: "missing key" }),
      async () => jsonResponse(503, { detail: "TURN_AUTH_SECRET missing" }),
      async () => {
        throw new Error("network down");
      },
      async () => jsonResponse(200, ALLOCATE_PRIVATE_TURN),
    ];
    for (const fetchImpl of cases) {
      const result = await sessionGatedAllocate({
        sessionAddress: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        env: HOP_ENV,
        fetchImpl,
      });
      assert.equal(result.status, 503);
      assert.deepEqual(result.body, { error: "turn-unavailable" });
    }
  });

  it("hopPanopticonAllocate is null on empty body", async () => {
    const cfg = readTurnAllocateEnv(HOP_ENV);
    assert.ok(cfg);
    const missed = await hopPanopticonAllocate({
      cfg,
      fetchImpl: async () => jsonResponse(200, { nope: true }),
    });
    assert.equal(missed, null);
  });
});

describe("product consume locks", () => {
  it("keeps the API key on the Next hop and SIWE on this origin", () => {
    const hop = helperSource();
    const route = readFileSync(
      new URL("../app/api/turn/allocate/route.ts", import.meta.url),
      "utf8",
    );
    const ice = readFileSync(new URL("./turn-ice.ts", import.meta.url), "utf8");
    const tests = readFileSync(new URL("./turn-allocate.test.ts", import.meta.url), "utf8");
    assert.equal(hop.includes("X-Api-Key"), true);
    assert.equal(route.includes("readSessionToken"), true);
    assert.equal(route.includes("sessionGatedAllocate"), true);
    assert.equal(route.includes("NEXT_PUBLIC_"), false);
    assert.equal(ice.includes("NEXT_PUBLIC_"), false);
    assert.equal(ice.includes("TURN_AUTH_SECRET"), false);
    assert.equal(hop.includes("Keycloak"), false);
    assert.equal(route.includes("Keycloak"), false);
    assert.equal(hop.includes("Stripe"), false);
    assert.equal(hop.includes("gun.get"), false);
    assert.equal(ice.includes("gun.get"), false);
    assert.equal(tests.includes("fetchImpl"), true);
    assert.equal(tests.includes("jsonResponse(200, ALLOCATE_OK_BODY)"), true);
  });
});
