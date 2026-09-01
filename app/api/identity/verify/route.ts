import { SESSION_TTL_SECONDS } from "@/lib/identity/config";
import {
  nonceCookieName,
  requestHost,
  requestIsSecure,
  sessionCookieName,
} from "@/lib/identity/cookies";
import {
  identitySecretOrThrow,
  readNonceFromRequest,
  secretFailureResponse,
  setIdentityCookie,
} from "@/lib/identity/http";
import { readNonceToken } from "@/lib/identity/nonce";
import { signSessionToken } from "@/lib/identity/session";
import { verifySiweLogin } from "@/lib/identity/siwe";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type VerifyBody = {
  message?: unknown;
  signature?: unknown;
};

export async function POST(request: Request) {
  let secret: string;
  try {
    secret = identitySecretOrThrow();
  } catch (error) {
    return (
      secretFailureResponse(error) ??
      Response.json({ error: "Identity session is not configured." }, { status: 500 })
    );
  }

  let body: VerifyBody;
  try {
    body = (await request.json()) as VerifyBody;
  } catch {
    return Response.json({ error: "Expected JSON." }, { status: 400 });
  }

  const message = typeof body.message === "string" ? body.message : "";
  const signature = typeof body.signature === "string" ? body.signature : "";
  if (!message || !signature) {
    return Response.json({ error: "Send message and signature." }, { status: 400 });
  }

  const nonceToken = await readNonceFromRequest(request);
  if (!nonceToken) {
    return Response.json({ error: "Missing nonce cookie." }, { status: 400 });
  }

  let expectedNonce: string;
  try {
    expectedNonce = (await readNonceToken(nonceToken, secret)).nonce;
  } catch {
    return Response.json({ error: "Nonce cookie is invalid or expired." }, { status: 400 });
  }

  const result = await verifySiweLogin({
    message,
    signature,
    expectedNonce,
    requestHost: requestHost(request),
  });

  if (!result.ok) {
    const status = result.error.includes("signature") ? 401 : 400;
    return Response.json({ error: result.error }, { status });
  }

  const session = await signSessionToken(
    { address: result.address, chainId: result.chainId },
    secret,
  );
  const secure = requestIsSecure(request);
  await setIdentityCookie(
    sessionCookieName(secure),
    session,
    secure,
    SESSION_TTL_SECONDS,
  );
  await setIdentityCookie(nonceCookieName(secure), "", secure, 0);

  return Response.json({ address: result.address, chainId: result.chainId });
}
