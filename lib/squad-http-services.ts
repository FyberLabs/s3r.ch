import { createSquadAssignmentService } from "./squad-assignment-service";
import { createForumAuthorityService } from "./forum-authority-service";
import { createIdentitySessions } from "./identity/sea-session";
import { createSquadSessionHandlers } from "./identity/squad-session-http";

/** The site identity issuer authenticates; each Squad owns its authority scope. No routes are
 * registered until deployment supplies secret, durable replay and atomic source. */
export function createSquadHttpServices(input: Omit<Parameters<typeof createForumAuthorityService>[0], "authenticate"> & {
  assignments?: Pick<Parameters<typeof createSquadAssignmentService>[0], "source" | "runtime">;
  secret: string;
  consume: Parameters<typeof createIdentitySessions>[0]["consume"];
}) {
  const sessions = createIdentitySessions(input);
  const handlers = createSquadSessionHandlers({ origin: input.origin, sessions });
  const authority = createForumAuthorityService({ ...input, authenticate: handlers.authenticate });
  const assignments = input.assignments ? createSquadAssignmentService({ ...input.assignments, runtime: { ...input.assignments.runtime, config: input.config, clock: input.clock }, squad: input.squad, origin: input.origin, authenticate: handlers.authenticate }) : undefined;
  return Object.freeze({ ...handlers, authority, assignments });
}
