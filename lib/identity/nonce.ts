import { generateNonce } from "siwe";
import { SignJWT, jwtVerify } from "jose";
import { NONCE_TTL_SECONDS } from "./config";
import { secretKey } from "./secret";

export type NonceClaims = {
  nonce: string;
  iat: number;
  exp: number;
};

export function randomNonce(): string {
  return generateNonce();
}

export async function signNonceToken(
  nonce: string,
  secret: string,
  now = Date.now(),
): Promise<string> {
  return new SignJWT({ nonce })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(Math.floor(now / 1000))
    .setExpirationTime(Math.floor(now / 1000) + NONCE_TTL_SECONDS)
    .sign(secretKey(secret));
}

export async function readNonceToken(
  token: string,
  secret: string,
): Promise<NonceClaims> {
  const { payload } = await jwtVerify(token, secretKey(secret), {
    algorithms: ["HS256"],
  });
  const nonce = payload.nonce;
  if (typeof nonce !== "string" || nonce.length < 8) {
    throw new Error("Nonce cookie is missing a valid nonce.");
  }
  if (typeof payload.iat !== "number" || typeof payload.exp !== "number") {
    throw new Error("Nonce cookie is missing iat/exp.");
  }
  return { nonce, iat: payload.iat, exp: payload.exp };
}

export async function issueNonce(
  secret: string,
  now = Date.now(),
): Promise<{ nonce: string; token: string }> {
  const nonce = randomNonce();
  const token = await signNonceToken(nonce, secret, now);
  return { nonce, token };
}
