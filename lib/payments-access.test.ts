import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  HOP_ENV,
  INTENT_OK_BODY,
  INTENT_UNAVAILABLE_BODY,
  PAYMENTS_AMOUNT,
  PAYMENTS_INTENT_ID,
  PAYMENTS_RESOURCE,
  PAYMENTS_TX_REF,
  RECEIPT_BAD_VERIFIED,
  RECEIPT_ERROR_BODY,
  RECEIPT_EXPIRED_BODY,
  RECEIPT_NOT_FOUND_BODY,
  RECEIPT_OK_BODY,
  RECEIPT_UNVERIFIED_BODY,
} from "./payments-access.fixtures";
import {
  DEFAULT_CLIENT_HINT,
  ENV_API_KEY,
  ENV_PAYMENTS_BASE,
  ENV_TENANT_ID,
  hopPanopticonReceipt,
  panopticonPaymentsUrl,
  parseIntentBody,
  parseIntentResponse,
  parseReceiptBody,
  parseReceiptResponse,
  paymentsHopHeaders,
  readPaymentsAccessEnv,
  receiptRequestBody,
  sanitizeAmount,
  sanitizeClientHint,
  sanitizeIdentifier,
  sessionGatedIntent,
  sessionGatedReceipt,
} from "./payments-access";

function helperSource(): string {
  return readFileSync(new URL("./payments-access.ts", import.meta.url), "utf8");
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const SESSION = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

describe("readPaymentsAccessEnv", () => {
  it("is null when any of the three server env names is empty", () => {
    assert.equal(readPaymentsAccessEnv({}), null);
    assert.equal(
      readPaymentsAccessEnv({
        ...HOP_ENV,
        PANOPTICON_PAYMENTS_BASE: "",
      }),
      null,
    );
    assert.equal(
      readPaymentsAccessEnv({
        ...HOP_ENV,
        PANOPTICON_API_KEY: "  ",
      }),
      null,
    );
    assert.equal(
      readPaymentsAccessEnv({
        ...HOP_ENV,
        PANOPTICON_PAYMENTS_BASE: "ftp://pay.example.com",
      }),
      null,
    );
  });

  it("accepts http(s) lab and product bases, including localhost", () => {
    const cfg = readPaymentsAccessEnv(HOP_ENV);
    assert.deepEqual(cfg, {
      base: "https://api.test.hyperme.sh",
      tenantId: HOP_ENV.PANOPTICON_TENANT_ID,
      apiKey: HOP_ENV.PANOPTICON_API_KEY,
    });
    const local = readPaymentsAccessEnv({
      ...HOP_ENV,
      PANOPTICON_PAYMENTS_BASE: "http://localhost:8014/",
    });
    assert.equal(local?.base, "http://localhost:8014");
    assert.equal(ENV_PAYMENTS_BASE, "PANOPTICON_PAYMENTS_BASE");
    assert.equal(ENV_TENANT_ID, "PANOPTICON_TENANT_ID");
    assert.equal(ENV_API_KEY, "PANOPTICON_API_KEY");
  });
});

describe("panopticonPaymentsUrl", () => {
  it("joins the locked receipt/intent URIs from origin or /api/v1 prefix", () => {
    assert.equal(
      panopticonPaymentsUrl("https://api.test.hyperme.sh", "receipt"),
      "https://api.test.hyperme.sh/api/v1/payments/v0/receipt",
    );
    assert.equal(
      panopticonPaymentsUrl("https://api.test.hyperme.sh", "intent"),
      "https://api.test.hyperme.sh/api/v1/payments/v0/intent",
    );
    assert.equal(
      panopticonPaymentsUrl("http://localhost:8014/api/v1", "receipt"),
      "http://localhost:8014/api/v1/payments/v0/receipt",
    );
    assert.equal(
      panopticonPaymentsUrl("https://api.test.hyperme.sh/api/v1/payments", "intent"),
      "https://api.test.hyperme.sh/api/v1/payments/v0/intent",
    );
    assert.equal(
      panopticonPaymentsUrl("https://api.test.hyperme.sh/api/v1/payments/v0", "receipt"),
      "https://api.test.hyperme.sh/api/v1/payments/v0/receipt",
    );
    assert.equal(
      panopticonPaymentsUrl(
        "https://api.test.hyperme.sh/api/v1/payments/v0/receipt",
        "receipt",
      ),
      "https://api.test.hyperme.sh/api/v1/payments/v0/receipt",
    );
  });
});

describe("payments hop headers and identifiers", () => {
  it("sends X-Tenant-ID + X-Api-Key and never NEXT_PUBLIC", () => {
    const cfg = readPaymentsAccessEnv(HOP_ENV);
    assert.ok(cfg);
    const headers = paymentsHopHeaders(cfg);
    assert.equal(headers["X-Tenant-ID"], HOP_ENV.PANOPTICON_TENANT_ID);
    assert.equal(headers["X-Api-Key"], HOP_ENV.PANOPTICON_API_KEY);
    assert.equal("Authorization" in headers, false);
    const src = helperSource();
    // Comment already contains NEXT_PUBLIC_*; lock the consume name, not that substring.
    assert.equal(src.includes("NEXT_PUBLIC_PAYMENTS"), false);
    assert.equal(src.includes("Never NEXT_PUBLIC_*"), true);
    assert.equal(src.includes(`process.env.${ENV_API_KEY}`), false);
    assert.equal(ENV_API_KEY, "PANOPTICON_API_KEY");
    assert.equal(
      readPaymentsAccessEnv({
        PANOPTICON_PAYMENTS_BASE: HOP_ENV.PANOPTICON_PAYMENTS_BASE,
        PANOPTICON_TENANT_ID: HOP_ENV.PANOPTICON_TENANT_ID,
        NEXT_PUBLIC_PANOPTICON_API_KEY: HOP_ENV.PANOPTICON_API_KEY,
      }),
      null,
    );
    assert.equal(src.includes("localStorage"), true);
    assert.equal(src.includes("Never Gun"), true);
    assert.equal(src.includes("Never Stripe"), true);
    assert.equal(src.includes("Never SIWE-as-Panopticon-login"), true);
  });

  it("admits contract identifiers and rejects fetch URLs", () => {
    assert.equal(sanitizeIdentifier(PAYMENTS_RESOURCE, "resource"), PAYMENTS_RESOURCE);
    assert.equal(sanitizeIdentifier(PAYMENTS_TX_REF, "txRef"), PAYMENTS_TX_REF);
    assert.equal(sanitizeIdentifier("https://pay.example/content", "resource"), null);
    assert.equal(sanitizeIdentifier("content essay", "resource"), null);
    assert.equal(sanitizeIdentifier("", "resource"), null);
    assert.equal(sanitizeAmount(PAYMENTS_AMOUNT), PAYMENTS_AMOUNT);
    assert.equal(sanitizeAmount(undefined), undefined);
    assert.equal(sanitizeAmount("0"), null);
    assert.equal(sanitizeAmount("-1.00"), null);
    assert.equal(sanitizeClientHint(""), DEFAULT_CLIENT_HINT);
    assert.equal(sanitizeClientHint(SESSION), SESSION);
    assert.deepEqual(
      receiptRequestBody({
        resource: PAYMENTS_RESOURCE,
        txRef: PAYMENTS_TX_REF,
        asset: "USDC",
        amount: PAYMENTS_AMOUNT,
        clientHint: "s3rch-next",
      }),
      {
        resource: PAYMENTS_RESOURCE,
        txRef: PAYMENTS_TX_REF,
        asset: "USDC",
        amount: PAYMENTS_AMOUNT,
        clientHint: "s3rch-next",
      },
    );
  });
});

describe("parse request/response fixtures", () => {
  it("admits the integrator-doc JSON", () => {
    assert.deepEqual(parseIntentResponse(INTENT_OK_BODY), INTENT_OK_BODY);
    assert.deepEqual(parseIntentResponse(INTENT_UNAVAILABLE_BODY), {
      ...INTENT_UNAVAILABLE_BODY,
      intentId: null,
      payTo: null,
      memo: null,
      expiresAt: null,
    });
    assert.deepEqual(parseReceiptResponse(RECEIPT_OK_BODY), RECEIPT_OK_BODY);
    assert.deepEqual(parseReceiptResponse(RECEIPT_NOT_FOUND_BODY), RECEIPT_NOT_FOUND_BODY);
    assert.deepEqual(parseReceiptResponse(RECEIPT_UNVERIFIED_BODY), RECEIPT_UNVERIFIED_BODY);
    assert.deepEqual(parseReceiptResponse(RECEIPT_EXPIRED_BODY), RECEIPT_EXPIRED_BODY);
    assert.deepEqual(parseReceiptResponse(RECEIPT_ERROR_BODY), RECEIPT_ERROR_BODY);
  });

  it("rejects bad verified accessUntil and ok/status mismatch", () => {
    assert.equal(parseReceiptResponse(RECEIPT_BAD_VERIFIED), null);
    assert.equal(
      parseReceiptResponse({
        ok: true,
        status: "not_found",
        resource: PAYMENTS_RESOURCE,
        accessUntil: null,
        upstream: "mock",
      }),
      null,
    );
    assert.equal(parseIntentResponse({ ok: true, status: "error" }), null);
    assert.equal("error" in parseReceiptBody({ resource: PAYMENTS_RESOURCE }), true);
    assert.equal(
      "error" in parseIntentBody({ resource: "https://127.0.0.1/pay" }),
      true,
    );
  });
});

describe("sessionGatedReceipt", () => {
  it("is 401 without a SIWE session", async () => {
    const result = await sessionGatedReceipt({
      sessionAddress: null,
      body: { resource: PAYMENTS_RESOURCE, txRef: PAYMENTS_TX_REF },
      env: HOP_ENV,
    });
    assert.equal(result.status, 401);
    assert.deepEqual(result.body, { error: "unauthorized" });
  });

  it("is 503 when env is empty (fail-soft, no paywall)", async () => {
    const result = await sessionGatedReceipt({
      sessionAddress: SESSION,
      body: { resource: PAYMENTS_RESOURCE, txRef: PAYMENTS_TX_REF },
      env: {},
    });
    assert.equal(result.status, 503);
    assert.deepEqual(result.body, { error: "payments-unconfigured" });
  });

  it("is 400 on a fetch-URL resource", async () => {
    const result = await sessionGatedReceipt({
      sessionAddress: SESSION,
      body: { resource: "https://etherscan.io/tx/0x1", txRef: PAYMENTS_TX_REF },
      env: HOP_ENV,
    });
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, { error: "invalid-resource" });
  });

  it("hops POST receipt and returns plane JSON including ok:false", async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const result = await sessionGatedReceipt({
      sessionAddress: SESSION,
      body: {
        resource: PAYMENTS_RESOURCE,
        txRef: PAYMENTS_TX_REF,
        intentId: PAYMENTS_INTENT_ID,
        asset: "USDC",
        amount: PAYMENTS_AMOUNT,
      },
      env: HOP_ENV,
      fetchImpl: async (url, init) => {
        seen.push({ url: String(url), init });
        return jsonResponse(200, RECEIPT_OK_BODY);
      },
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, RECEIPT_OK_BODY);
    assert.equal(seen.length, 1);
    assert.equal(
      seen[0].url,
      "https://api.test.hyperme.sh/api/v1/payments/v0/receipt",
    );
    assert.equal(seen[0].init?.method, "POST");
    const headers = seen[0].init?.headers as Record<string, string>;
    assert.equal(headers["X-Tenant-ID"], HOP_ENV.PANOPTICON_TENANT_ID);
    assert.equal(headers["X-Api-Key"], HOP_ENV.PANOPTICON_API_KEY);
    const body = JSON.parse(String(seen[0].init?.body)) as {
      resource: string;
      txRef: string;
      clientHint: string;
    };
    assert.equal(body.resource, PAYMENTS_RESOURCE);
    assert.equal(body.txRef, PAYMENTS_TX_REF);
    assert.equal(body.clientHint, SESSION);

    const soft = await sessionGatedReceipt({
      sessionAddress: SESSION,
      body: { resource: PAYMENTS_RESOURCE, txRef: "0xmissing" },
      env: HOP_ENV,
      fetchImpl: async () => jsonResponse(200, RECEIPT_NOT_FOUND_BODY),
    });
    assert.equal(soft.status, 200);
    assert.deepEqual(soft.body, RECEIPT_NOT_FOUND_BODY);
  });

  it("fails soft on 401, 503, network, and unparseable JSON", async () => {
    const cases: Array<() => Promise<Response>> = [
      async () => jsonResponse(401, { error: "missing key" }),
      async () => jsonResponse(503, { detail: "PAYMENTS_UPSTREAM must be mock" }),
      async () => {
        throw new Error("network down");
      },
      async () => jsonResponse(200, RECEIPT_BAD_VERIFIED),
    ];
    for (const fetchImpl of cases) {
      const result = await sessionGatedReceipt({
        sessionAddress: SESSION,
        body: { resource: PAYMENTS_RESOURCE, txRef: PAYMENTS_TX_REF },
        env: HOP_ENV,
        fetchImpl,
      });
      assert.equal(result.status, 503);
      assert.deepEqual(result.body, { error: "payments-unavailable" });
    }
  });

  it("hopPanopticonReceipt is null on empty body", async () => {
    const cfg = readPaymentsAccessEnv(HOP_ENV);
    assert.ok(cfg);
    const missed = await hopPanopticonReceipt({
      cfg,
      body: {
        resource: PAYMENTS_RESOURCE,
        txRef: PAYMENTS_TX_REF,
        asset: "USDC",
        clientHint: DEFAULT_CLIENT_HINT,
      },
      fetchImpl: async () => jsonResponse(200, { nope: true }),
    });
    assert.equal(missed, null);
  });
});

describe("sessionGatedIntent", () => {
  it("is 401 without a SIWE session and 503 when env is empty", async () => {
    const unauth = await sessionGatedIntent({
      sessionAddress: null,
      body: { resource: PAYMENTS_RESOURCE },
      env: HOP_ENV,
    });
    assert.equal(unauth.status, 401);
    const empty = await sessionGatedIntent({
      sessionAddress: SESSION,
      body: { resource: PAYMENTS_RESOURCE },
      env: {},
    });
    assert.equal(empty.status, 503);
    assert.deepEqual(empty.body, { error: "payments-unconfigured" });
  });

  it("hops POST intent and passes through ok:false unavailable", async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const quoted = await sessionGatedIntent({
      sessionAddress: SESSION,
      body: { resource: PAYMENTS_RESOURCE, asset: "USDC", amount: PAYMENTS_AMOUNT },
      env: HOP_ENV,
      fetchImpl: async (url, init) => {
        seen.push({ url: String(url), init });
        return jsonResponse(200, INTENT_OK_BODY);
      },
    });
    assert.equal(quoted.status, 200);
    assert.deepEqual(quoted.body, INTENT_OK_BODY);
    assert.equal(seen[0].url, "https://api.test.hyperme.sh/api/v1/payments/v0/intent");
    const soft = await sessionGatedIntent({
      sessionAddress: SESSION,
      body: { resource: "content:held:lab" },
      env: HOP_ENV,
      fetchImpl: async () => jsonResponse(200, INTENT_UNAVAILABLE_BODY),
    });
    assert.equal(soft.status, 200);
    assert.equal((soft.body as { status: string }).status, "unavailable");
  });
});

describe("product consume locks", () => {
  it("keeps the API key on the Next hop and SIWE on this origin", () => {
    const hop = helperSource();
    const receiptRoute = readFileSync(
      new URL("../app/api/payments/receipt/route.ts", import.meta.url),
      "utf8",
    );
    const intentRoute = readFileSync(
      new URL("../app/api/payments/intent/route.ts", import.meta.url),
      "utf8",
    );
    const tests = readFileSync(new URL("./payments-access.test.ts", import.meta.url), "utf8");
    assert.equal(hop.includes("X-Api-Key"), true);
    assert.equal(receiptRoute.includes("readSessionToken"), true);
    assert.equal(receiptRoute.includes("sessionGatedReceipt"), true);
    assert.equal(intentRoute.includes("sessionGatedIntent"), true);
    assert.equal(receiptRoute.includes("NEXT_PUBLIC_"), false);
    assert.equal(intentRoute.includes("NEXT_PUBLIC_"), false);
    assert.equal(hop.includes("Keycloak"), true);
    assert.equal(receiptRoute.includes("Keycloak"), false);
    assert.equal(hop.includes("Stripe"), true);
    assert.equal(hop.includes("core/payment-service"), true);
    assert.equal(hop.includes("gun.get"), false);
    assert.equal(hop.includes("/api/v1/payments/v0/receipt"), true);
    assert.equal(hop.includes("/api/v1/payments/v0/intent"), true);
    assert.equal(tests.includes("fetchImpl"), true);
    assert.equal(tests.includes("jsonResponse(200, RECEIPT_OK_BODY)"), true);
  });
});
