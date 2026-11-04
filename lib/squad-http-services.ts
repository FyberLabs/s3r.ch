import { createForumAuthorityService } from "./forum-authority-service";
import { createSquadSessions } from "./identity/squad-session";
import { createSquadSessionHandlers } from "./identity/squad-session-http";

/** One provisioned Squad owns both session and authority scope. No routes are
 * registered until deployment supplies secret, durable replay and atomic source. */
export function createSquadHttpServices(input: Omit<Parameters<typeof createForumAuthorityService>[0], "authenticate"> & {
  secret: string;
  consume: Parameters<typeof createSquadSessions>[0]["consume"];
}) {
  const sessions = createSquadSessions(input);
  const handlers = createSquadSessionHandlers({ origin: input.origin, sessions });
  const authority = createForumAuthorityService({ ...input, authenticate: handlers.authenticate });
  return Object.freeze({ ...handlers, authority });
}
