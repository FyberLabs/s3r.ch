import { authenticateAgentRequest } from "@/lib/identity/site-agent-session-server";
import { createNativeRoomBotReply, NATIVE_ROOM_REPLY_SCOPE } from "@/lib/native-room-bot-reply";
import { nativeRoomBotGun } from "@/lib/native-room-bot-gun";
import { matchesRequestOrigin } from "@/lib/request-origin";
import { getSquadPilotServer } from "@/lib/squad-pilot-server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const unavailable = () => Response.json({ error: "room-reply-unavailable" }, {
    status: 503, headers: { "Cache-Control": "no-store" },
  });

  try {
    const pilot = getSquadPilotServer();
    if (!pilot || !matchesRequestOrigin(request, new URL(pilot.config.origin))) return unavailable();
    return createNativeRoomBotReply({
      authenticate: incoming => authenticateAgentRequest(incoming, [NATIVE_ROOM_REPLY_SCOPE]),
      authority: pilot.config.authority,
      parent: { id: pilot.config.squad.forumId, owner: pilot.config.squad.owner },
      read: pilot.source.read,
      transport: nativeRoomBotGun(pilot.config.origin),
    })(request);
  } catch {
    return unavailable();
  }
}
