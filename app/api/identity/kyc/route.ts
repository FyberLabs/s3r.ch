import { attestKycForSession, kycIssuers } from "@/lib/identity/kyc";
import {
  identitySecretOrThrow,
  readSessionFromRequest,
  secretFailureResponse,
} from "@/lib/identity/http";
import { readSessionToken } from "@/lib/identity/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/identity/kyc
 *
 * Session required. Holds a third-party KYC attestation claim id.
 * Fixture issuer when no `KYC_ISSUER_URL`. Not a passport upload.
 * Does not write Gun.
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

  let body: { issuer?: unknown; subject?: unknown } = {};
  try {
    body = (await request.json()) as { issuer?: unknown; subject?: unknown };
  } catch {
    body = {};
  }

  const result = await attestKycForSession({
    sessionAddress,
    issuerId: body.issuer,
    subject: body.subject,
    issuers: kycIssuers(),
  });
  return Response.json(result.body, { status: result.status });
}
