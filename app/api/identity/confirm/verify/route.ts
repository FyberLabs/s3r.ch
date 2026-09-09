import {
  readConfirmChallenge,
  verifyHeldConfirm,
} from "@/lib/identity/confirm";
import { confirmCookieName, requestIsSecure } from "@/lib/identity/cookies";
import {
  identitySecretOrThrow,
  readConfirmFromRequest,
  readSessionFromRequest,
  secretFailureResponse,
  setIdentityCookie,
} from "@/lib/identity/http";
import { readSessionToken } from "@/lib/identity/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/identity/confirm/verify
 *
 * Session required. Verifies the confirm challenge cookie.
 * Returns the claim id. Does not write Gun or store PII server-side.
 */
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

  const token = await readSessionFromRequest(request);
  if (!token) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let sessionAddress: string;
  try {
    sessionAddress = (await readSessionToken(token, secret)).address;
  } catch {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { kind?: unknown; target?: unknown; code?: unknown } = {};
  try {
    body = (await request.json()) as {
      kind?: unknown;
      target?: unknown;
      code?: unknown;
    };
  } catch {
    return Response.json({ error: "invalid confirm" }, { status: 400 });
  }

  const challengeToken = await readConfirmFromRequest(request);
  let challenge = null;
  if (challengeToken) {
    try {
      challenge = await readConfirmChallenge(challengeToken, secret);
    } catch {
      challenge = null;
    }
  }

  const result = await verifyHeldConfirm({
    sessionAddress,
    kind: body.kind,
    target: body.target,
    code: body.code,
    challenge,
  });

  const secure = requestIsSecure(request);
  await setIdentityCookie(confirmCookieName(secure), "", secure, 0);
  return Response.json(result.body, { status: result.status });
}
