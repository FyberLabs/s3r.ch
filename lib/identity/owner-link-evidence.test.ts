import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { exportOwnerLinkEvidence } from "./owner-link-evidence";
import { buildMeshLinkStatement } from "./mesh-link";

const account = privateKeyToAccount(`0x${"0".repeat(63)}1`);
const pub = "axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";
const origin = "https://s3r.ch";
async function record() {
  const signedPayload = buildMeshLinkStatement({domain: "s3r.ch", uri: origin, address: account.address, seaPub: pub});
  return {address: account.address, seaPub: pub, signedPayload, walletSignature: await account.signMessage({message: signedPayload})};
}

describe("local owner link evidence", () => {
  it("verifies a real wallet signature and exports only fixed evidence fields", async () => {
    const row = await record();
    Object.defineProperty(row, "seaPair", {get() {throw Error("private key accessed");}});
    Object.defineProperty(row, "wrap", {get() {throw Error("wrap accessed");}});
    const result = JSON.parse(await exportOwnerLinkEvidence(row, account.address, origin));
    assert.deepEqual(Object.keys(result).sort(), ["kind","message","origin","sea_public_key","signature","version","wallet"]);
    assert.equal(result.wallet, account.address);
    assert.equal(result.sea_public_key, pub);
    assert.equal(result.message, row.signedPayload);
    assert.equal(result.signature, row.walletSignature);
    assert.equal(result.kind, "s3rch-local-wallet-link-evidence");
    assert.equal(await exportOwnerLinkEvidence(row, account.address, origin), JSON.stringify(result, null, 2)+"\n");
  });
  it("refuses absent, malformed, foreign, tampered and wrong-origin records", async () => {
    const row = await record();
    for (const value of [null, [], {}, {...row, seaPub: account.address}, {...row, signedPayload: row.signedPayload+"\n"},
      {...row, address: privateKeyToAccount(`0x${"0".repeat(63)}2`).address}, {...row, walletSignature: `0x${"00".repeat(65)}`}]) {
      await assert.rejects(exportOwnerLinkEvidence(value, account.address, origin), /^Error: Existing wallet link could not be verified\.$/);
    }
    for (const badOrigin of ["https://test.s3r.ch", "http://s3r.ch", "https://s3r.ch/path", "https://s3r.ch.evil.example"])
      await assert.rejects(exportOwnerLinkEvidence(row, account.address, badOrigin), /could not be verified/);
  });
});
