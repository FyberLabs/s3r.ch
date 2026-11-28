import { matchesRequestOrigin } from "@/lib/request-origin";
import { getSiteAclServer } from "@/lib/site-acl-server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const unavailable = () => Response.json({ error: "room-reply-unavailable" }, {
    status: 503, headers: { "Cache-Control": "no-store" },
  });
  try {
    const site = getSiteAclServer();
    if (!site || !matchesRequestOrigin(request, new URL(site.config.origin))) return unavailable();
    return unavailable();
  } catch {
    return unavailable();
  }
}