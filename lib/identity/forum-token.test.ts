import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { SignJWT } from "jose";
import { LOCAL_SESSION_SECRET, SESSION_TTL_SECONDS } from "./config";
import { readForumBotToken, signForumBotToken } from "./forum-token";
import { secretKey } from "./secret";

const ALICE = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

describe("forum bot token", () => {
  it("roundtrips the sociacl owner and is not a Hypermesh API key", async () => {
    const now = Date.now();
    const token = await signForumBotToken(
      { owner: ALICE.toLowerCase() },
      LOCAL_SESSION_SECRET,
      now,
    );
    assert.equal(token.includes("hm_"), false);
    const claims = await readForumBotToken(token, LOCAL_SESSION_SECRET);
    assert.equal(claims.owner, ALICE);
    assert.equal(claims.exp - claims.iat, SESSION_TTL_SECONDS);
    await assert.rejects(() =>
      readForumBotToken(token, `${LOCAL_SESSION_SECRET}-other-secret-value`),
    );
  });

  it("rejects a token whose kind is not forum-bot", async () => {
    const now = Math.floor(Date.now() / 1000);
    const other = await new SignJWT({ kind: "session", owner: ALICE })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(ALICE)
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .sign(secretKey(LOCAL_SESSION_SECRET));
    await assert.rejects(() => readForumBotToken(other, LOCAL_SESSION_SECRET));
  });

  it("is not a stored secret and does not touch Gun", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./forum-token.ts", import.meta.url)),
      "utf8",
    );
    assert.equal(/from ["']gun/.test(source), false);
    assert.equal(source.includes("writeFile"), false);
    assert.equal(source.includes("client_secret"), false);
    assert.equal(source.includes("hm_"), false);
  });
});
