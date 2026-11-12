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

// Both release colors receive the same setting; color is not part of a cookie.
it("accepts cookies bidirectionally across release instances sharing the secret", async () => {
  const blue = { secret: SECRET }, green = { secret: SECRET };
  for (const [writer, reader] of [[blue, green], [green, blue]]) {
    const cookie = await signSessionToken({ address: ADDRESS, chainId: 1 }, writer.secret);
    assert.equal((await readSessionToken(cookie, reader.secret)).address, ADDRESS);
    await assert.rejects(readSessionToken(cookie, reader.secret + "rotated"));
  }
});
