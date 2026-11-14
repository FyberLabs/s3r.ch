import {
  identitySecretOrThrow,
  readSessionFromRequest,
  secretFailureResponse,
} from "@/lib/identity/http";
import { readSeaRequestSession } from "@/lib/identity/sea-request-session";
import { readSessionToken } from "@/lib/identity/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * `address` is the wallet that signed. `owner` is the sociacl owner of
 * Gun and Check objects. The mesh key stays on `address`.
 */
export async function GET(request: Request) {
  let secret: string;
  try {
    secret = identitySecretOrThrow();
  } catch (error) {
    return (
      secretFailureResponse(error) ??
      Response.json({ error: "Identity session is not configured." }, { status: 500 })
    );
  }

  const sea = await readSeaRequestSession(request);
  const token = await readSessionFromRequest(request);
  if (sea) {
    const credential = token ? await readSessionToken(token, secret).catch(() => null) : null;
    return Response.json({ owner: sea.key, address: credential?.address ?? "",
      chainId: credential?.chainId ?? 1, expiresAt: sea.expiresAt });
  }
  if (!token) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const session = await readSessionToken(token, secret);
    // A credential-only session may render login controls, never an owner.
    const owner = "";
    return Response.json({
      address: session.address,
      chainId: session.chainId,
      expiresAt: session.exp * 1000,
      owner,
    });
  } catch {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
}
