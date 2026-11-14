import { callbackUriFor } from "./oauth";
import { requestHost, requestIsSecure } from "../request-origin";
import { getIdentitySecret } from "./secret";
import { readSeaSessionCookie } from "./squad-session-http";
import { createIdentityTokenVerifier } from "./sea-session-verifier";

/** Only the existing SEA proof session is a principal. Linked credential and
 * legacy wallet cookies cannot be substituted for it. No issuer is constructed. */
export async function readSeaRequestSession(request: Request, env: Record<string, string | undefined> = process.env,
  clock?: () => number): Promise<{ key: string; expiresAt: number } | null> {
  try {
    const callback = callbackUriFor(requestHost(request), requestIsSecure(request));
    const token = readSeaSessionCookie(request);
    if (!callback || !token) return null;
    const claims = await createIdentityTokenVerifier({ origin: new URL(callback).origin, secret: getIdentitySecret(env), clock }).claims(token, "s3rch-identity-session-v1", 300);
    return { key: claims.key, expiresAt: claims.expiresAt * 1000 };
  } catch { return null; }
}
