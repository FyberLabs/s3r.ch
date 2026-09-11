import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  ATTEST_BAD_OBSERVED_AT,
  ATTEST_HOP_ENV,
  ATTEST_MISSING_SUBJECT,
  ATTEST_NOT_FOUND_BODY,
  ATTEST_OK_BODY,
  ATTEST_OK_WITHOUT_DIGEST,
  ATTEST_RELAY_OK_BODY,
  ATTEST_RELAY_SUBJECT,
  ATTEST_SUBJECT,
} from "./oracles-attest.fixtures";
import {
  DEFAULT_CLIENT_HINT,
  ENV_API_KEY,
  ENV_ORACLES_BASE,
  ENV_TENANT_ID,
  PANOPTICON_ATTEST_PATH,
  attestHopHeaders,
  hopPanopticonAttest,
  isPublicHttpsSubject,
  panopticonAttestUrl,
  parseAttestRequest,
  parseAttestResponse,
  readOraclesAttestEnv,
  sanitizeAttestSubject,
  sanitizeClientHint,
  sessionGatedAttest,
} from "./oracles-attest";

function helperSource(): string {
  return readFileSync(new URL("./oracles-attest.ts", import.meta.url), "utf8");
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("readOraclesAttestEnv", () => {
  it("is null when any of the three server env names is empty", () => {
    assert.equal(readOraclesAttestEnv({}), null);
    assert.equal(
      readOraclesAttestEnv({
        ...ATTEST_HOP_ENV,
        PANOPTICON_ORACLES_BASE: "",
      }),
      null,
    );
    assert.equal(
      readOraclesAttestEnv({
        ...ATTEST_HOP_ENV,
        PANOPTICON_API_KEY: "  ",
      }),
      null,
    );
    assert.equal(
      readOraclesAttestEnv({
        ...ATTEST_HOP_ENV,
        PANOPTICON_ORACLES_BASE: "ftp://oracles.example.com",
      }),
      null,
    );
    assert.equal(
      readOraclesAttestEnv({
        PANOPTICON_TURN_BASE: "https://api.test.hyperme.sh",
        PANOPTICON_TENANT_ID: ATTEST_HOP_ENV.PANOPTICON_TENANT_ID,
        PANOPTICON_API_KEY: ATTEST_HOP_ENV.PANOPTICON_API_KEY,
      }),
      null,
    );
  });

  it("accepts http(s) lab and product bases, including localhost", () => {
    const cfg = readOraclesAttestEnv(ATTEST_HOP_ENV);
    assert.deepEqual(cfg, {
      base: "https://api.test.hyperme.sh",
      tenantId: ATTEST_HOP_ENV.PANOPTICON_TENANT_ID,
      apiKey: ATTEST_HOP_ENV.PANOPTICON_API_KEY,
    });
    const local = readOraclesAttestEnv({
      ...ATTEST_HOP_ENV,
      PANOPTICON_ORACLES_BASE: "http://localhost:8013/",
    });
    assert.equal(local?.base, "http://localhost:8013");
    assert.equal(ENV_ORACLES_BASE, "PANOPTICON_ORACLES_BASE");
    assert.equal(ENV_TENANT_ID, "PANOPTICON_TENANT_ID");
    assert.equal(ENV_API_KEY, "PANOPTICON_API_KEY");
  });
});

describe("panopticonAttestUrl", () => {
  it("joins the locked attest URI from origin or /api/v1 prefix", () => {
    assert.equal(
      panopticonAttestUrl("https://api.test.hyperme.sh"),
      "https://api.test.hyperme.sh/api/v1/oracles/v0/attest",
    );
    assert.equal(
      panopticonAttestUrl("http://localhost:8013/api/v1"),
      "http://localhost:8013/api/v1/oracles/v0/attest",
    );
    assert.equal(
      panopticonAttestUrl("https://api.test.hyperme.sh/api/v1/oracles"),
      "https://api.test.hyperme.sh/api/v1/oracles/v0/attest",
    );
    assert.equal(
      panopticonAttestUrl("https://api.test.hyperme.sh/api/v1/oracles/v0"),
      "https://api.test.hyperme.sh/api/v1/oracles/v0/attest",
    );
    assert.equal(
      panopticonAttestUrl("https://api.test.hyperme.sh/api/v1/oracles/v0/attest"),
      "https://api.test.hyperme.sh/api/v1/oracles/v0/attest",
    );
    assert.equal(PANOPTICON_ATTEST_PATH, "/api/v1/oracles/v0/attest");
  });
});

describe("attest hop headers and hint", () => {
  it("sends X-Tenant-ID + X-Api-Key and never NEXT_PUBLIC", () => {
    const cfg = readOraclesAttestEnv(ATTEST_HOP_ENV);
    assert.ok(cfg);
    const headers = attestHopHeaders(cfg);
    assert.equal(headers["X-Tenant-ID"], ATTEST_HOP_ENV.PANOPTICON_TENANT_ID);
    assert.equal(headers["X-Api-Key"], ATTEST_HOP_ENV.PANOPTICON_API_KEY);
    assert.equal("Authorization" in headers, false);
    const src = helperSource();
    assert.equal(src.includes("NEXT_PUBLIC_ORACLES"), false);
    assert.equal(src.includes("Never NEXT_PUBLIC_*"), true);
    assert.equal(src.includes("localStorage"), true);
    assert.equal(src.includes("Never Gun"), true);
  });

  it("locks clientHint to s3rch-next", () => {
    assert.equal(DEFAULT_CLIENT_HINT, "s3rch-next");
    assert.equal(sanitizeClientHint("s3rch-next"), "s3rch-next");
    assert.equal(sanitizeClientHint(""), DEFAULT_CLIENT_HINT);
  });
});

describe("sanitizeAttestSubject", () => {
  it("admits the integrator-doc identifier and public https relay", () => {
    assert.equal(sanitizeAttestSubject("public_attestation", ATTEST_SUBJECT), ATTEST_SUBJECT);
    assert.equal(
      sanitizeAttestSubject("public_relay", ATTEST_RELAY_SUBJECT),
      ATTEST_RELAY_SUBJECT,
    );
    assert.equal(isPublicHttpsSubject(ATTEST_RELAY_SUBJECT), true);
  });

  it("rejects private / credentialed / http relay subjects", () => {
    assert.equal(sanitizeAttestSubject("public_relay", "https://10.0.0.8/health"), null);
    assert.equal(sanitizeAttestSubject("public_relay", "https://relay.ts.net/health"), null);
    assert.equal(sanitizeAttestSubject("public_relay", "http://relay.test.example/health"), null);
    assert.equal(
      sanitizeAttestSubject("public_relay", "https://user:secret@relay.test.example/health"),
      null,
    );
    assert.equal(sanitizeAttestSubject("public_relay", ATTEST_SUBJECT), null);
    assert.equal(sanitizeAttestSubject("public_attestation", "eas uid"), null);
    assert.equal(sanitizeAttestSubject("public_attestation", ""), null);
    assert.equal(isPublicHttpsSubject("https://127.0.0.1/health"), false);
  });
});

describe("parseAttestRequest / parseAttestResponse", () => {
  it("admits the integrator-doc request and JSON", () => {
    assert.deepEqual(
      parseAttestRequest({
        kind: "public_attestation",
        subject: ATTEST_SUBJECT,
        clientHint: "s3rch-next",
      }),
      {
        kind: "public_attestation",
        subject: ATTEST_SUBJECT,
      },
    );
    const parsed = parseAttestResponse(ATTEST_OK_BODY);
    assert.ok(parsed);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.status, "observed");
    assert.equal(parsed.digest, ATTEST_OK_BODY.digest);
    assert.ok(parseAttestResponse(ATTEST_NOT_FOUND_BODY));
    assert.ok(parseAttestResponse(ATTEST_RELAY_OK_BODY));
  });

  it("rejects bad kind, private subject, and unparseable plane JSON", () => {
    assert.equal(parseAttestRequest({ kind: "verify", subject: ATTEST_SUBJECT }), null);
    assert.equal(parseAttestRequest({ kind: "public_attestation" }), null);
    assert.ok(parseAttestResponse(ATTEST_OK_WITHOUT_DIGEST));
    assert.equal(parseAttestResponse(ATTEST_BAD_OBSERVED_AT), null);
    assert.equal(parseAttestResponse({ ...ATTEST_OK_BODY, ok: false }), null);
    assert.equal(parseAttestResponse({ ...ATTEST_NOT_FOUND_BODY, digest: "sha256:ab" }), null);
  });
});

describe("sessionGatedAttest", () => {
  it("is 401 without a SIWE session", async () => {
    const result = await sessionGatedAttest({
      sessionAddress: null,
      body: { kind: "public_attestation", subject: ATTEST_SUBJECT },
      env: ATTEST_HOP_ENV,
    });
    assert.equal(result.status, 401);
    assert.deepEqual(result.body, { error: "unauthorized" });
  });

  it("is 400 on invalid kind or subject before hopping", async () => {
    const seen: string[] = [];
    const result = await sessionGatedAttest({
      sessionAddress: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      body: { kind: "public_relay", subject: "https://10.0.0.8/health" },
      env: ATTEST_HOP_ENV,
      fetchImpl: async (url) => {
        seen.push(String(url));
        return jsonResponse(200, ATTEST_OK_BODY);
      },
    });
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, { error: "invalid-subject" });
    assert.deepEqual(seen, []);
  });

  it("is 503 when env is empty (fail-soft, no invented credentials)", async () => {
    const result = await sessionGatedAttest({
      sessionAddress: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      body: { kind: "public_attestation", subject: ATTEST_SUBJECT },
      env: {},
    });
    assert.equal(result.status, 503);
    assert.deepEqual(result.body, { error: "oracles-unconfigured" });
  });

  it("hops POST attest and returns the plane observation", async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const result = await sessionGatedAttest({
      sessionAddress: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      body: {
        kind: "public_attestation",
        subject: ATTEST_SUBJECT,
        clientHint: "not-this-label",
      },
      env: ATTEST_HOP_ENV,
      fetchImpl: async (url, init) => {
        seen.push({ url: String(url), init });
        return jsonResponse(200, ATTEST_OK_BODY);
      },
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, parseAttestResponse(ATTEST_OK_BODY));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "https://api.test.hyperme.sh/api/v1/oracles/v0/attest");
    assert.equal(seen[0].init?.method, "POST");
    const headers = seen[0].init?.headers as Record<string, string>;
    assert.equal(headers["X-Tenant-ID"], ATTEST_HOP_ENV.PANOPTICON_TENANT_ID);
    assert.equal(headers["X-Api-Key"], ATTEST_HOP_ENV.PANOPTICON_API_KEY);
    const body = JSON.parse(String(seen[0].init?.body)) as {
      kind: string;
      subject: string;
      clientHint: string;
    };
    assert.equal(body.kind, "public_attestation");
    assert.equal(body.subject, ATTEST_SUBJECT);
    assert.equal(body.clientHint, DEFAULT_CLIENT_HINT);
  });

  it("passes through plane 200 ok:false (not_found) without inventing a digest", async () => {
    const result = await sessionGatedAttest({
      sessionAddress: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      body: { kind: "public_attestation", subject: ATTEST_MISSING_SUBJECT },
      env: ATTEST_HOP_ENV,
      fetchImpl: async () => jsonResponse(200, ATTEST_NOT_FOUND_BODY),
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, ATTEST_NOT_FOUND_BODY);
    if (result.status === 200) {
      assert.equal(result.body.ok, false);
      assert.equal(result.body.digest, null);
    }
  });

  it("fails soft on 401, 503, network, and unparseable JSON", async () => {
    const cases: Array<() => Promise<Response>> = [
      async () => jsonResponse(401, { error: "missing key" }),
      async () => jsonResponse(503, { detail: "ORACLES_UPSTREAM missing" }),
      async () => {
        throw new Error("network down");
      },
      async () => jsonResponse(200, { ...ATTEST_OK_BODY, observedAt: "not-a-date" }),
    ];
    for (const fetchImpl of cases) {
      const result = await sessionGatedAttest({
        sessionAddress: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        body: { kind: "public_attestation", subject: ATTEST_SUBJECT },
        env: ATTEST_HOP_ENV,
        fetchImpl,
      });
      assert.equal(result.status, 503);
      assert.deepEqual(result.body, { error: "oracles-unavailable" });
    }
  });

  it("hopPanopticonAttest is null on empty body", async () => {
    const cfg = readOraclesAttestEnv(ATTEST_HOP_ENV);
    assert.ok(cfg);
    const missed = await hopPanopticonAttest({
      cfg,
      request: {
        kind: "public_attestation",
        subject: ATTEST_SUBJECT,
      },
      fetchImpl: async () => jsonResponse(200, { nope: true }),
    });
    assert.equal(missed, null);
  });
});

describe("product consume locks", () => {
  it("keeps the API key on the Next hop and SIWE on this origin", () => {
    const hop = helperSource();
    const route = readFileSync(
      new URL("../app/api/oracles/attest/route.ts", import.meta.url),
      "utf8",
    );
    const tests = readFileSync(new URL("./oracles-attest.test.ts", import.meta.url), "utf8");
    assert.equal(hop.includes("X-Api-Key"), true);
    assert.equal(route.includes("readSessionToken"), true);
    assert.equal(route.includes("sessionGatedAttest"), true);
    assert.equal(route.includes("NEXT_PUBLIC_"), false);
    assert.equal(hop.includes("Keycloak"), false);
    assert.equal(route.includes("Keycloak"), false);
    assert.equal(hop.includes("Stripe"), false);
    assert.equal(hop.includes("gun.get"), false);
    assert.equal(hop.includes("/api/v1/oracles/v0/verify"), false);
    assert.equal(tests.includes("fetchImpl"), true);
    assert.equal(tests.includes("jsonResponse(200, ATTEST_OK_BODY)"), true);
  });
});
