import { createForumAuthority, type ForumAuthorityConfig, type ForumAuthoritySnapshot } from "./identity/forum-authority";
import { isPublicSquadPrincipal } from "./squad-view";
/** Only a deployment-provisioned complete primary source may implement read.
 * This adapter never treats a caller snapshot or Gun peers as complete history. */
export function createMediaAuthority(input: {
  config: ForumAuthorityConfig;
  authenticate(request: Request): Promise<{ key: string } | null>;
  read(at: number, signal: AbortSignal): Promise<ForumAuthoritySnapshot>;
  clock?: () => number;
}) {
  const config = structuredClone(input.config), clock = input.clock ?? (() => Math.floor(Date.now() / 1000));
  return async (request: Request, object: string, action: "read" | "write", signal: AbortSignal): Promise<boolean> => {
    signal.throwIfAborted();
    const at = clock(), session = await input.authenticate(request);
    signal.throwIfAborted();
    if (clock() !== at || !session || isPublicSquadPrincipal(session.key)) return false;
    const snapshot = structuredClone(await input.read(at, signal));
    if (!Array.isArray(snapshot.rows) || snapshot.rows.length > 1024 || JSON.stringify(snapshot).length > 4 * 1024 * 1024) return false;
    const authority = createForumAuthority(config, clock), result = await authority.refresh(snapshot, at);
    signal.throwIfAborted();
    if (!result.ok || result.diagnostics.length || clock() !== at) return false;
    const principal = authority.graph.principalForKey(session.key, at);
    if (!principal || isPublicSquadPrincipal(principal)) return false;
    return action === "write" ? authority.graph.ownerOf(object) === principal : authority.graph.checkDirectSee(object, principal, at).allowed;
  };
}
