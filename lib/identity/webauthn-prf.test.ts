import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PRF_UNAVAILABLE_MESSAGE,
  PrfUnavailableError,
  createPrfCredential,
  detectPrfAvailability,
  evaluatePrf,
  readPrfFromExtensionResults,
} from "./webauthn-prf";

const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

function prfBytes(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

describe("WebAuthn PRF helper", () => {
  it("reports unavailable when PublicKeyCredential is missing", async () => {
    const result = await detectPrfAvailability(undefined);
    assert.equal(result.available, false);
    if (!result.available) {
      assert.match(result.reason, /Google Password Manager/);
      assert.match(result.reason, /iOS 18\.4/);
    }
  });

  it("honours getClientCapabilities extension:prf = false", async () => {
    const fake = {
      getClientCapabilities: async () => ({ "extension:prf": false }),
    } as unknown as typeof PublicKeyCredential;
    const result = await detectPrfAvailability(fake);
    assert.equal(result.available, false);
  });

  it("reads PRF results and refuses a missing or short output", () => {
    const first = prfBytes();
    assert.deepEqual(
      readPrfFromExtensionResults({ prf: { enabled: true, results: { first: first.buffer } } }),
      first,
    );
    assert.throws(() => readPrfFromExtensionResults({ prf: { enabled: false } }), PrfUnavailableError);
    assert.throws(
      () => readPrfFromExtensionResults({ prf: { enabled: true, results: { first: new Uint8Array(8) } } }),
      PrfUnavailableError,
    );
  });

  it("creates a credential via native PRF eval (synthetic authenticator)", async () => {
    const first = prfBytes();
    const rawId = crypto.getRandomValues(new Uint8Array(16));
    const credentials = {
      async create() {
        return {
          rawId: rawId.buffer,
          getClientExtensionResults: () => ({
            prf: { enabled: true, results: { first: first.buffer } },
          }),
        };
      },
      async get() {
        throw new Error("get should not run when create returns PRF");
      },
    } as unknown as CredentialsContainer;

    const result = await createPrfCredential({
      address: ADDRESS,
      rpId: "localhost",
      credentials,
    });
    assert.deepEqual(result.credentialId, rawId);
    assert.deepEqual(result.prfOutput, first);
    assert.equal(result.rpId, "localhost");
    assert.equal(result.prfSalt.byteLength, 32);
  });

  it("falls back to get() when create only reports PRF enabled", async () => {
    const first = prfBytes();
    const rawId = crypto.getRandomValues(new Uint8Array(16));
    let got = 0;
    const credentials = {
      async create() {
        return {
          rawId: rawId.buffer,
          getClientExtensionResults: () => ({ prf: { enabled: true } }),
        };
      },
      async get() {
        got += 1;
        return {
          rawId: rawId.buffer,
          getClientExtensionResults: () => ({
            prf: { enabled: true, results: { first } },
          }),
        };
      },
    } as unknown as CredentialsContainer;

    const result = await createPrfCredential({
      address: ADDRESS,
      rpId: "s3r.ch",
      credentials,
    });
    assert.equal(got, 1);
    assert.deepEqual(result.prfOutput, first);
  });

  it("does not fake a wrap when PRF results never arrive", async () => {
    const credentials = {
      async create() {
        return {
          rawId: new Uint8Array([1, 2, 3]).buffer,
          getClientExtensionResults: () => ({ prf: { enabled: false } }),
        };
      },
      async get() {
        return {
          rawId: new Uint8Array([1, 2, 3]).buffer,
          getClientExtensionResults: () => ({}),
        };
      },
    } as unknown as CredentialsContainer;

    await assert.rejects(
      () => createPrfCredential({ address: ADDRESS, rpId: "localhost", credentials }),
      (error: unknown) => {
        assert.ok(error instanceof PrfUnavailableError);
        assert.match(error.message, /not wrapped|not available/);
        return true;
      },
    );
  });

  it("evaluatePrf returns synthetic first output", async () => {
    const first = prfBytes();
    const credentials = {
      async get() {
        return {
          getClientExtensionResults: () => ({
            prf: { enabled: true, results: { first } },
          }),
        };
      },
    } as unknown as CredentialsContainer;
    const out = await evaluatePrf({
      rpId: "localhost",
      credentialId: new Uint8Array([1]),
      prfSalt: prfBytes(),
      credentials,
    });
    assert.deepEqual(out, first);
  });

  it("exports the locked degrade copy", () => {
    assert.match(PRF_UNAVAILABLE_MESSAGE, /The mesh key was not wrapped/);
  });
});
