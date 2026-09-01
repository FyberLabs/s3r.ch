import { getAddress } from "viem";
import { SignJWT, jwtVerify } from "jose";
import { SESSION_TTL_SECONDS } from "./config";
import { secretKey } from "./secret";

export type SessionClaims = {
  address: string;
  chainId: number;
  iat: number;
  exp: number;
};

export async function signSessionToken(
  input: { address: string; chainId: number },
  secret: string,
  now = Date.now(),
): Promise<string> {
  const address = getAddress(input.address);
  const iat = Math.floor(now / 1000);
  return new SignJWT({ address, chainId: input.chainId })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(address)
    .setIssuedAt(iat)
    .setExpirationTime(iat + SESSION_TTL_SECONDS)
    .sign(secretKey(secret));
}

export async function readSessionToken(
  token: string,
  secret: string,
): Promise<SessionClaims> {
  const { payload } = await jwtVerify(token, secretKey(secret), {
    algorithms: ["HS256"],
  });
  if (typeof payload.address !== "string") {
    throw new Error("Session cookie is missing address.");
  }
  if (typeof payload.chainId !== "number" || !Number.isInteger(payload.chainId)) {
    throw new Error("Session cookie is missing chainId.");
  }
  if (typeof payload.iat !== "number" || typeof payload.exp !== "number") {
    throw new Error("Session cookie is missing iat/exp.");
  }
  return {
    address: getAddress(payload.address),
    chainId: payload.chainId,
    iat: payload.iat,
    exp: payload.exp,
  };
}
