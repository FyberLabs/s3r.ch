import { secretFailureResponse } from "@/lib/identity/http";
import { ownerForOAuth } from "@/lib/identity/link";
import { readBackupFromRequest } from "@/lib/identity/oauth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Backup session view. No Keycloak subject and no provider tokens. */
export async function GET(request: Request) {
  try {
    const backup = await readBackupFromRequest(request);
    if (!backup) return Response.json({ error: "unauthorized" }, { status: 401 });
    const owner = ownerForOAuth(backup.sub);
    return Response.json({
      idp: backup.idp,
      linked: owner !== null,
      owner,
    });
  } catch (error) {
    return (
      secretFailureResponse(error) ??
      Response.json({ error: "unauthorized" }, { status: 401 })
    );
  }
}
