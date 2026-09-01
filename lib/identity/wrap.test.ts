import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SECONDARY_WRAP_STATEMENT } from "./config";
import type { SeaPair } from "./sea";
import {
  PAPER_BACKUP_INVALID_MESSAGE,
  PAPER_BACKUP_UNLOCK_FAILED_MESSAGE,
  SEA_WRAP_HKDF_INFO,
  base64UrlToBytes,
  buildSecondaryWrapStatement,
  bytesToBase64Url,
  decodePaperBackup,
  encodePaperBackup,
  isPrfWrapEnvelope,
  quietPaperBackupError,
  randomPaperSecondaryKey,
  resolveRpId,
  secondaryIkmFromWalletSignature,
  unwrapDek,
  unwrapSeaPair,
  wrapDek,
  wrapSeaPair,
} from "./wrap";

const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

function fixturePair(pub = "sea-pub-1"): SeaPair {
  return { pub, priv: "sea-priv-1", epub: "sea-epub-1", epriv: "sea-epriv-1" };
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

describe("PRF wrap crypto", () => {
  it("uses the locked HKDF info string", () => {
    assert.equal(SEA_WRAP_HKDF_INFO, "s3r.ch/sea-wrap/aes-gcm/v1");
  });

  it("resolves per-origin rp.id and rejects a parent / lookalike host", () => {
    assert.equal(resolveRpId("s3r.ch"), "s3r.ch");
    assert.equal(resolveRpId("localhost:3000"), "localhost");
    assert.equal(resolveRpId("127.0.0.1"), "127.0.0.1");
    assert.throws(() => resolveRpId("evil.s3r.ch"), /rp\.id is not allowed/);
    assert.throws(() => resolveRpId("s3r.ch.evil.com"), /rp\.id is not allowed/);
  });

  it("wraps and unwraps a SEA pair with synthetic PRF + secondary bytes", async () => {
    const prfOutput = randomBytes(32);
    const secondaryKey = randomBytes(32);
    const envelope = await wrapSeaPair({
      pair: fixturePair(),
      address: ADDRESS.toLowerCase(),
      rpId: "localhost",
      credentialId: randomBytes(16),
      prfSalt: randomBytes(32),
      prfOutput,
      secondaryKey,
      secondarySalt: randomBytes(32),
      secondaryKind: "paper",
    });

    assert.equal(isPrfWrapEnvelope(envelope), true);
    assert.equal(envelope.version, 1);
    assert.equal(envelope.address, ADDRESS);
    assert.equal(envelope.seaPub, "sea-pub-1");
    assert.equal(envelope.alg.hkdfInfo, "s3r.ch/sea-wrap/aes-gcm/v1");
    assert.doesNotMatch(JSON.stringify(envelope), /sea-priv-1/);
    assert.doesNotMatch(JSON.stringify(envelope), /sea-epriv-1/);

    const viaPrf = await unwrapSeaPair({ envelope, prfOutput, expectedAddress: ADDRESS });
    const viaSecondary = await unwrapSeaPair({
      envelope,
      secondaryKey,
      expectedAddress: ADDRESS.toLowerCase(),
    });
    assert.deepEqual(viaPrf, fixturePair());
    assert.deepEqual(viaSecondary, fixturePair());
  });

  it("lets either wrapped DEK recover the same 32-byte key", async () => {
    const dek = randomBytes(32);
    const prfOutput = randomBytes(32);
    const secondaryKey = randomBytes(32);
    const wrapped = await wrapDek({ dek, prfOutput, secondaryKey, address: ADDRESS });
    const fromPrf = await unwrapDek({ ...wrapped, address: ADDRESS, prfOutput });
    const fromSecondary = await unwrapDek({ ...wrapped, address: ADDRESS, secondaryKey });
    assert.deepEqual(fromPrf, dek);
    assert.deepEqual(fromSecondary, dek);
  });

  it("does not treat raw PRF bytes as the AES key", async () => {
    const dek = randomBytes(32);
    const prfOutput = randomBytes(32);
    const secondaryKey = randomBytes(32);
    const wrapped = await wrapDek({ dek, prfOutput, secondaryKey, address: ADDRESS });
    await assert.rejects(
      () =>
        unwrapDek({
          dekWrappedByPrfKek: wrapped.dekWrappedByPrfKek,
          dekWrappedBySecondaryKek: wrapped.dekWrappedBySecondaryKek,
          address: ADDRESS,
          prfOutput: dek,
        }),
      /Could not unwrap/,
    );
    const rawPrf = new Uint8Array(prfOutput);
    const rawKey = await crypto.subtle.importKey("raw", rawPrf, "AES-GCM", false, ["decrypt"]);
    const packed = base64UrlToBytes(wrapped.dekWrappedByPrfKek);
    const aad = new TextEncoder().encode(`s3r.ch/sea-wrap/dek/prf/v1\n${ADDRESS}`);
    const iv = new Uint8Array(packed.subarray(0, 12));
    const ct = new Uint8Array(packed.subarray(12));
    await assert.rejects(
      () =>
        crypto.subtle.decrypt(
          { name: "AES-GCM", iv, additionalData: aad },
          rawKey,
          ct,
        ),
      /OperationError|decrypt/i,
    );
  });

  it("rejects a wrong PRF or secondary IKM", async () => {
    const envelope = await wrapSeaPair({
      pair: fixturePair(),
      address: ADDRESS,
      rpId: "s3r.ch",
      credentialId: randomBytes(16),
      prfSalt: randomBytes(32),
      prfOutput: randomBytes(32),
      secondaryKey: randomBytes(32),
    });
    await assert.rejects(
      () => unwrapSeaPair({ envelope, prfOutput: randomBytes(32) }),
      /Could not unwrap/,
    );
    await assert.rejects(
      () => unwrapSeaPair({ envelope, secondaryKey: randomBytes(32) }),
      /Could not unwrap/,
    );
  });

  it("rejects an address mismatch and a half-built envelope", async () => {
    const prfOutput = randomBytes(32);
    const envelope = await wrapSeaPair({
      pair: fixturePair(),
      address: ADDRESS,
      rpId: "s3r.ch",
      credentialId: randomBytes(16),
      prfSalt: randomBytes(32),
      prfOutput,
      secondaryKey: randomBytes(32),
    });
    await assert.rejects(
      () =>
        unwrapSeaPair({
          envelope,
          prfOutput,
          expectedAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        }),
      /different address/,
    );
    assert.equal(isPrfWrapEnvelope({ ...envelope, ciphertext: undefined }), false);
    assert.equal(isPrfWrapEnvelope({ ...envelope, dekWrappedBySecondaryKek: "" }), false);
    assert.equal(
      isPrfWrapEnvelope({ ...envelope, alg: { ...envelope.alg, hkdfInfo: "wrong" } }),
      false,
    );
  });

  it("roundtrips a paper backup string and a wallet-signature IKM", () => {
    const key = randomPaperSecondaryKey();
    const paper = encodePaperBackup(key);
    assert.match(paper, /^s3rch-wrap-v1:/);
    assert.deepEqual(decodePaperBackup(paper), key);
    assert.equal(key.byteLength, 32);

    const sig = `0x${Buffer.from(randomBytes(65)).toString("hex")}`;
    const ikm = secondaryIkmFromWalletSignature(sig);
    assert.equal(ikm.byteLength, 65);
  });

  it("rejects a garbage paper prefix and invalid payload without echoing secrets", () => {
    assert.throws(() => decodePaperBackup("not-a-backup"), /not a s3r.ch wrap v1/);
    assert.throws(() => decodePaperBackup("s3rch-wrap-v1:???"), /Invalid base64url/);
    assert.throws(() => decodePaperBackup("s3rch-wrap-v1:"), /Invalid base64url/);
    const short = `s3rch-wrap-v1:${bytesToBase64Url(randomBytes(15))}`;
    assert.throws(() => decodePaperBackup(short), /too short/);
    assert.equal(
      quietPaperBackupError(new Error("Paper backup is not a s3r.ch wrap v1 string.")),
      PAPER_BACKUP_INVALID_MESSAGE,
    );
    assert.equal(
      quietPaperBackupError(new Error("Invalid base64url.")),
      PAPER_BACKUP_INVALID_MESSAGE,
    );
    const leaked = quietPaperBackupError(new Error("s3rch-wrap-v1:SECRETPRIV"));
    assert.equal(leaked, PAPER_BACKUP_UNLOCK_FAILED_MESSAGE);
    assert.doesNotMatch(leaked, /SECRETPRIV|s3rch-wrap-v1/);
  });

  it("unwraps a paper secondary without PRF and fails quietly on the wrong paper", async () => {
    const paperKey = randomPaperSecondaryKey();
    const envelope = await wrapSeaPair({
      pair: fixturePair(),
      address: ADDRESS,
      rpId: "localhost",
      credentialId: randomBytes(16),
      prfSalt: randomBytes(32),
      prfOutput: randomBytes(32),
      secondaryKey: paperKey,
      secondaryKind: "paper",
    });
    assert.equal(envelope.secondaryKind, "paper");

    const viaPaper = await unwrapSeaPair({
      envelope,
      secondaryKey: decodePaperBackup(encodePaperBackup(paperKey)),
    });
    assert.deepEqual(viaPaper, fixturePair());

    const wrong = randomPaperSecondaryKey();
    await assert.rejects(
      () => unwrapSeaPair({ envelope, secondaryKey: wrong }),
      /Could not unwrap/,
    );
    try {
      await unwrapSeaPair({ envelope, secondaryKey: wrong });
      assert.fail("wrong paper must not unwrap");
    } catch (error) {
      const quiet = quietPaperBackupError(error);
      assert.equal(quiet, PAPER_BACKUP_UNLOCK_FAILED_MESSAGE);
      assert.doesNotMatch(quiet, /sea-priv|epriv|s3rch-wrap-v1/);
    }
  });

  it("builds a domain-bound secondary statement without privkeys", () => {
    const salt = randomBytes(32);
    const statement = buildSecondaryWrapStatement({
      domain: "localhost:3000",
      uri: "http://localhost:3000",
      address: ADDRESS.toLowerCase(),
      secondarySalt: salt,
    });
    assert.match(statement, new RegExp(SECONDARY_WRAP_STATEMENT));
    assert.match(statement, /Address: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266/);
    assert.match(statement, new RegExp(`Secondary salt: ${bytesToBase64Url(salt)}`));
    assert.doesNotMatch(statement, /\bpriv\b/);
    assert.doesNotMatch(statement, /epriv/);
  });
});
