import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LOCAL_SESSION_SECRET } from "./config";
import { readSessionToken, signSessionToken } from "./session";

const SECRET = LOCAL_SESSION_SECRET;
const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

describe("session cookie", () => {
  it("roundtrips a checksummed address and chainId", async () => {
    const token = await signSessionToken({ address: ADDRESS.toLowerCase(), chainId: 1 }, SECRET);
    const claims = await readSessionToken(token, SECRET);
    assert.equal(claims.address, ADDRESS);
    assert.equal(claims.chainId, 1);
    assert.ok(claims.exp > claims.iat);
  });

  it("rejects a token signed with another secret", async () => {
    const token = await signSessionToken({ address: ADDRESS, chainId: 8453 }, SECRET);
    await assert.rejects(() => readSessionToken(token, `${SECRET}-other-secret-value-32chars!!`));
  });
});
