import type { ForumAuthorityGraph, ForumAuthoritySnapshot } from "./identity/forum-authority";
import { parseForumAuthority } from "./identity/forum-authority-records";

/** Call only after successful refresh of complete authenticated history.
 * An old ownership signature is harmless only when current ownership of that
 * same object is already admitted. All grant and cancellation diagnostics deny. */
export function roomAuthorityDiagnosticsBlock(diagnostics: readonly { index: number; reason: string }[],
  snapshot: ForumAuthoritySnapshot, graph: ForumAuthorityGraph): boolean {
  return diagnostics.some(diagnostic => {
    const envelope = snapshot.rows[diagnostic.index];
    if (diagnostic.reason !== "retired-key" || envelope?.kind !== "object") return true;
    const parsed = parseForumAuthority(envelope.kind, envelope.record);
    return !parsed || parsed.kind !== "object" || graph.ownerOf(parsed.row.object) !== parsed.row.owner;
  });
}
