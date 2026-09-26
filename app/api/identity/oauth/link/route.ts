import {
  identitySecretOrThrow,
  readSessionFromRequest,
  secretFailureResponse,
} from "@/lib/identity/http";
import { linkLoginPaths, ownerForOAuth } from "@/lib/identity/link";
import { readBackupFromRequest } from "@/lib/identity/oauth";
import { readSessionToken } from "@/lib/identity/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Bind the current SIWE wallet and the current OAuth backup both ways.
 * The sociacl owner is the checksummed address. An unlinked call is 401.
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

  const siwe = await readSessionFromRequest(request);
  const backup = await readBackupFromRequest(request).catch(() => null);
  if (!siwe || !backup) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let wallet: string;
  try {
    wallet = (await readSessionToken(siwe, secret)).address;
  } catch {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const bound = linkLoginPaths({ wallet, sub: backup.sub, idp: backup.idp });
  if ("denied" in bound) {
    const status = bound.reason === "already-linked" ? 409 : 400;
    return Response.json({ denied: true, reason: bound.reason }, { status });
  }
  return Response.json({
    owner: ownerForOAuth(backup.sub) ?? bound.owner,
    linked: true,
    idp: backup.idp,
  });
}
