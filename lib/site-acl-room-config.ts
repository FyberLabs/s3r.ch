import { readSeaRequestSession } from "./identity/sea-request-session";
import { getSiteAclServer } from "./site-acl-server";
import { publicSiteClientConfig } from "./site-acl-config";

export function siteRoomConfigResult(authenticated: boolean, site: ReturnType<typeof getSiteAclServer>) {
  if (!authenticated) return { status: 401 as const, config: null };
  if (!site) return { status: 404 as const, config: null };
  return { status: 200 as const, config: publicSiteClientConfig(site.config) };
}

/** Authenticated browser clients load forum session endpoints from this response. */
export async function siteRoomConfigResponse(request: Request): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  const session = await readSeaRequestSession(request);
  const result = siteRoomConfigResult(Boolean(session), getSiteAclServer());
  return Response.json({ config: result.config }, { status: result.status, headers });
}