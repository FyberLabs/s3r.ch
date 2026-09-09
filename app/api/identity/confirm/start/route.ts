import { CONFIRM_TTL_SECONDS } from "@/lib/identity/config";
import {
  confirmFixtureEnabled,
  envConfirmSender,
  signConfirmChallenge,
  startHeldConfirm,
} from "@/lib/identity/confirm";
import { confirmCookieName, requestIsSecure } from "@/lib/identity/cookies";
import {
  identitySecretOrThrow,
  readSessionFromRequest,
  secretFailureResponse,
  setIdentityCookie,
} from "@/lib/identity/http";
import { readSessionToken } from "@/lib/identity/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/identity/confirm/start
 *
 * Session required. Starts email/phone confirm for the session address.
 * Does not write Gun. Live send is env-gated; unset fails soft.
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

  let body: { kind?: unknown; target?: unknown } = {};
  try {
    body = (await request.json()) as { kind?: unknown; target?: unknown };
  } catch {
    return Response.json({ error: "invalid target" }, { status: 400 });
  }

  const result = await startHeldConfirm({
    sessionAddress,
    kind: body.kind,
    target: body.target,
    fixtureEnabled: confirmFixtureEnabled(),
    sender: envConfirmSender(),
  });

  if (result.status !== 200 || !("challenge" in result) || !result.challenge) {
    return Response.json(result.body, { status: result.status });
  }

  const secure = requestIsSecure(request);
  const cookie = await signConfirmChallenge(result.challenge, secret);
  await setIdentityCookie(
    confirmCookieName(secure),
    cookie,
    secure,
    CONFIRM_TTL_SECONDS,
  );
  return Response.json(result.body, { status: 200 });
}
