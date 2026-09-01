import { NONCE_TTL_SECONDS } from "@/lib/identity/config";
import {
  nonceCookieName,
  requestIsSecure,
} from "@/lib/identity/cookies";
import {
  identitySecretOrThrow,
  secretFailureResponse,
  setIdentityCookie,
} from "@/lib/identity/http";
import { issueNonce } from "@/lib/identity/nonce";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  let secret: string;
  try {
    secret = identitySecretOrThrow();
  } catch (error) {
    return secretFailureResponse(error) ?? Response.json({ error: "Identity session is not configured." }, { status: 500 });
  }

  const { nonce, token } = await issueNonce(secret);
  const secure = requestIsSecure(request);
  await setIdentityCookie(nonceCookieName(secure), token, secure, NONCE_TTL_SECONDS);
  return Response.json({ nonce });
}
