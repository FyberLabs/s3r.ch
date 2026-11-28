import { matchesRequestOrigin } from "@/lib/request-origin";
import { getSquadForumServer } from "@/lib/squad-forum-server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const unavailable = () => Response.json({ error: "room-reply-unavailable" }, {
    status: 503, headers: { "Cache-Control": "no-store" },
  });
  try {
    const site = getSquadForumServer();
    if (!site || !matchesRequestOrigin(request, new URL(site.origin))) return unavailable();
    return unavailable();
  } catch {
    return unavailable();
  }
}