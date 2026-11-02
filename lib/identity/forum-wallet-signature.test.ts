import assert from "node:assert/strict";
import test from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import rotations from "./vectors/forum-rotation-record.json";
import { verifyForumWalletSignature } from "./forum-wallet-signature";
const proof = rotations.accept[0].input.authorizer.siwe!;
const address = proof.message.split("\n")[1];
// Public deterministic test key; never a production identity.
const account = privateKeyToAccount(('0x' + '0'.repeat(63) + '4') as `0x${string}`);

test("verifies upstream rotation proofs and rejects the damaged proof fixture", async () => {
  for (const vector of rotations.accept) {
    const p = vector.input.authorizer.siwe!;
    assert.equal(await verifyForumWalletSignature(address, p.message, p.signature), vector.name !== "damaged-rotation-proof-same-id", vector.name);
  }
});

test("message bytes, signer and canonical checksum are bound", async () => {
  for (const message of [proof.message + " ", proof.message.replaceAll("\n", "\r\n"), "", proof.message.slice(1)]) {
    assert.equal(await verifyForumWalletSignature(address, message, proof.signature), false);
  }
  for (const a of [address.toLowerCase(), address.toUpperCase(), '0x' + '00'.repeat(20), 'not-address']) {
    assert.equal(await verifyForumWalletSignature(a, proof.message, proof.signature), false);
  }
});

test("uses UTF-8 byte length for EIP-191 and accepts both recovery encodings", async () => {
  const message = "Recovery é 🔑\nexact bytes";
  const signature = await account.signMessage({ message });
  assert.ok(await verifyForumWalletSignature(account.address, message, signature));
  const v = Number.parseInt(signature.slice(-2), 16);
  const alternate = signature.slice(0, -2) + (v >= 27 ? v - 27 : v + 27).toString(16).padStart(2, '0');
  assert.ok(await verifyForumWalletSignature(account.address, message, alternate));
  for (const recovery of ['02', '1d', '25', 'ff']) {
    assert.equal(await verifyForumWalletSignature(account.address, message, signature.slice(0, -2) + recovery), false);
  }
});

test("rejects unsupported signatures and untrusted input types without coercion", async () => {
  for (const sig of [null, {}, proof.signature.slice(0, -2), proof.signature + '00', '0x' + '00'.repeat(65), proof.signature.replace('0x', '0X')]) {
    assert.equal(await verifyForumWalletSignature(address, proof.message, sig), false);
  }
  const hostile = { toString() { throw Error('coerced'); } };
  assert.equal(await verifyForumWalletSignature(hostile, proof.message, proof.signature), false);
  assert.equal(await verifyForumWalletSignature(address, hostile, proof.signature), false);
  assert.equal(await verifyForumWalletSignature(address, 'x'.repeat(8193), proof.signature), false);
});

test("signature validity alone does not validate SIWE or grant recovery", async () => {
  const message = "This is not a SIWE recovery authorization";
  const signature = await account.signMessage({ message });
  assert.ok(await verifyForumWalletSignature(account.address, message, signature));
});
