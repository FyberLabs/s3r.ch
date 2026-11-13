import { createBotStatementAdmission, type BotStatementSource } from "./forum-bot-statement-admission";
import { createForumAuthorityService } from "./forum-authority-service";
import { createIdentitySessions } from "./identity/sea-session";
import { createSquadSessionHandlers } from "./identity/squad-session-http";

/** The site identity issuer authenticates; each Squad owns its authority scope. No routes are
 * registered until deployment supplies secret, durable replay and atomic source. */
export function createSquadHttpServices(input: Omit<Parameters<typeof createForumAuthorityService>[0], "authenticate"> & {
  statements?: BotStatementSource;
  secret: string;
  challengeDomain?: string;
  consume: Parameters<typeof createIdentitySessions>[0]["consume"];
}) {
  const sessions = createIdentitySessions(input);
  const handlers = createSquadSessionHandlers({ origin: input.origin, sessions });
  const read = input.statements ? async (at: number, signal: AbortSignal) =>
    (await input.statements!.read(at, signal)).snapshot : input.read;
  const authority = createForumAuthorityService({ ...input, read, authenticate: handlers.authenticate });
  const statements = input.statements ? createBotStatementAdmission({ ...input, source: input.statements, authenticate: handlers.authenticate }) : undefined;
  return Object.freeze({ ...handlers, authority, statements });
}
