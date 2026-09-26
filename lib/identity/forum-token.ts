/**
 * Owner-scoped forum credential for a headless bot.
 *
 * The subject is the sociacl owner (checksummed address). It is not a
 * Hypermesh API key and not a second owner. Signed with the existing
 * identity session secret. Nothing here is written to Gun.
 */

import { getAddress } from "viem";
import { SignJWT, jwtVerify } from "jose";
import { SESSION_TTL_SECONDS } from "./config";
import { secretKey } from "./secret";

export type ForumBotToken = {
  owner: string;
  iat: number;
  exp: number;
};

export async function signForumBotToken(
  input: { owner: string },
  secret: string,
  now = Date.now(),
): Promise<string> {
  const owner = getAddress(input.owner);
  const iat = Math.floor(now / 1000);
  return new SignJWT({ kind: "forum-bot", owner })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(owner)
    .setIssuedAt(iat)
    .setExpirationTime(iat + SESSION_TTL_SECONDS)
    .sign(secretKey(secret));
}

export async function readForumBotToken(token: string, secret: string): Promise<ForumBotToken> {
  const { payload } = await jwtVerify(token, secretKey(secret), { algorithms: ["HS256"] });
  if (payload.kind !== "forum-bot") throw new Error("Forum token is invalid.");
  if (typeof payload.owner !== "string") throw new Error("Forum token is invalid.");
  if (typeof payload.iat !== "number" || typeof payload.exp !== "number") {
    throw new Error("Forum token is invalid.");
  }
  return { owner: getAddress(payload.owner), iat: payload.iat, exp: payload.exp };
}
