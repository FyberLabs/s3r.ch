import {
  identitySecretOrThrow,
  readSessionFromRequest,
  secretFailureResponse,
} from "@/lib/identity/http";
import { ownerForWallet } from "@/lib/identity/link";
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

  const token = await readSessionFromRequest(request);
  if (!token) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const session = await readSessionToken(token, secret);
    const owner = ownerForWallet(session.address) ?? session.address;
    return Response.json({
      address: session.address,
      chainId: session.chainId,
      owner,
    });
  } catch {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
}
