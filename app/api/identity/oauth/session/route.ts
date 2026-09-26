import { secretFailureResponse } from "@/lib/identity/http";
import { readBackupFromRequest } from "@/lib/identity/oauth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Backup session only. No Keycloak subject, no tokens, not a SIWE address. */
export async function GET(request: Request) {
  try {
    const session = await readBackupFromRequest(request);
    if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
    return Response.json({ idp: session.idp, linked: false });
  } catch (error) {
    return (
      secretFailureResponse(error) ??
      Response.json({ error: "unauthorized" }, { status: 401 })
    );
  }
}
