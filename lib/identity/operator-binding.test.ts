import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { operatorBindingStatement, verifyOperatorBinding, type OperatorBinding } from "./operator-binding";

// Synthetic unit fixture only. Production verification never receives these keys.
const wallet = privateKeyToAccount(`0x${"0".repeat(63)}1`);
const pair = generateKeyPairSync("ec", {namedCurve: "prime256v1"});
const jwk = pair.publicKey.export({format: "jwk"});
const declared = {domain: "test.s3r.ch", wallet: wallet.address, sea_public_key: `${jwk.x}.${jwk.y}`};
async function fixture(): Promise<OperatorBinding> {
  const row = {...declared, version: 1 as const, purpose: "s3rch-operator-binding/v1" as const, timestamp: 1};
  return {...row, wallet_signature: await wallet.signMessage({message: operatorBindingStatement(row, "wallet-to-sea")}),
    sea_signature: sign("sha256", Buffer.from(operatorBindingStatement(row, "sea-to-wallet")),
      {key: pair.privateKey, dsaEncoding: "ieee-p1363"}).toString("base64url")};
}
test("verifies old durable reciprocal proofs without fresh signing or expiry", async () => {
  const row = await fixture();
  assert.deepEqual(await verifyOperatorBinding([row], declared), row);
  assert.ok(Object.isFrozen(await verifyOperatorBinding([row], declared)));
  assert.equal(operatorBindingStatement(row, "wallet-to-sea"),
    `s3rch-operator-binding/v1\nrole=wallet-to-sea\ndomain=test.s3r.ch\nwallet=${wallet.address}\nsea_public_key=${declared.sea_public_key}\ntimestamp=1`);
});
test("rejects missing, forged, mixed, malformed and conflicting declarations", async () => {
  const row = await fixture();
  for (const patch of [{wallet_signature: ""}, {sea_signature: ""}, {timestamp: 2}, {timestamp: -1},
    {domain: "evil.example"}, {purpose: "login"}, {version: true}, {sea_signature: "A".repeat(86)},
    {wallet_signature: `0x${"00".repeat(65)}`}, {extra: true}])
    assert.equal(await verifyOperatorBinding([{...row, ...patch}], declared), null);
  for (const input of [null, [], {}, [row, row], [row, {...row, sea_public_key: "other"}],
    [row, {...row, wallet: row.wallet.toLowerCase(), sea_public_key: "other"}], Array(65).fill(row)])
    assert.equal(await verifyOperatorBinding(input, declared), null);
  for (const patch of [{domain: "other.example"}, {sea_public_key: "missing"}, {domain: "test.s3r.ch/path"}])
    assert.equal(await verifyOperatorBinding([row], {...declared, ...patch}), null);
  const wrongRole = sign("sha256", Buffer.from(operatorBindingStatement(row, "wallet-to-sea")),
    {key: pair.privateKey, dsaEncoding: "ieee-p1363"}).toString("base64url");
  assert.equal(await verifyOperatorBinding([{...row, sea_signature: wrongRole}], declared), null);
});
