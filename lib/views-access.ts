/**
 * Inline access states for Views (docs/views.md §3.7, PR 4): what a picker row shows before
 * the user commits, and what a window shows for each of its sources after.
 *
 * Native rooms are checked with SociACL Check (`checkSee` on the room soul). Posting rights
 * beyond the owner are not checked yet (post grants are a later item), so a see-grant shows
 * "read" only. Forum access is decided by the forum service, so a forum channel the user does
 * not own shows "checked when opened". Pulled open-protocol sources are read-only.
 */
import { checkSee, roomSoul, sameAccessor, type SeeGraph } from "./identity/check";
import { formatCanonical, type SourceRef } from "./views-source-ref";
import type { ViewWindow } from "./views-window";

export type AccessState =
  | { kind: "read"; post: boolean }
  /** Known source, no see-grant. Can be added as pending. */
  | { kind: "locked"; reason: string }
  | { kind: "signin" }
  /** Bluesky and Farcaster: posting needs per-user credentials (later item). */
  | { kind: "read-only-unlinked" }
  /** ActivityPub, Nostr, RSS: pulled, no outbound. */
  | { kind: "read-only" }
  /** Another s3r.ch network: read through its own seed peer (later item). */
  | { kind: "needs-connection" }
  /** Decided by the forum service when the channel is opened. */
  | { kind: "on-open" };

export type AccessContext = {
  /** Signed-in wallet, if any. */
  me?: string;
  /** This deployment's network (formatS3rchNetwork). */
  selfNetwork: string;
  /** Dest ACL (SeeAcl) for Check. */
  graph: SeeGraph;
  now: number;
};

export function sourceAccess(ref: SourceRef, ctx: AccessContext): AccessState {
  if (ref.network === "atproto" || ref.network === "farcaster") return { kind: "read-only-unlinked" };
  if (!ref.network.startsWith("s3rch:")) return { kind: "read-only" };
  if (ref.network !== ctx.selfNetwork) return { kind: "needs-connection" };
  if (!ctx.me) return { kind: "signin" };
  if (ref.kind === "forum") return sameAccessor(ref.owner, ctx.me) ? { kind: "read", post: true } : { kind: "on-open" };
  if (ref.kind !== "chat") return { kind: "on-open" };
  const result = checkSee(ctx.graph, roomSoul(ref.source), ctx.me, ctx.now);
  if (!result.allowed) return { kind: "locked", reason: result.reason };
  return { kind: "read", post: result.reason === "owner" };
}

/** Badge text for a picker row. */
export function accessLabel(state: AccessState): string {
  switch (state.kind) {
    case "read":
      return state.post ? "✓ read · ✓ post" : "✓ read";
    case "locked":
      return "🔒 No access";
    case "signin":
      return "Sign in required";
    case "read-only-unlinked":
      return "Read-only (posting not linked)";
    case "read-only":
      return "Read-only";
    case "needs-connection":
      return "Needs connection";
    case "on-open":
      return "Checked when opened";
  }
}

/** Whether a row can be picked: anything but signed-out and unreachable sources. */
export function canPick(state: AccessState): boolean {
  return state.kind !== "signin" && state.kind !== "needs-connection";
}

/** Whether a window may show a source's rows: only while the source can be read. */
export function canShowRows(state: AccessState): boolean {
  return state.kind === "read" || state.kind === "read-only" || state.kind === "read-only-unlinked";
}

/** A locked row is added as pending. */
export function addsAsPending(state: AccessState): boolean {
  return state.kind === "locked";
}

/** What a window shows for one of its sources. */
export type SourceStatus = "ready" | "waiting" | "declined" | "removed" | "signin" | "needs-connection";

/**
 * Status of a window source. A locked source shows "Waiting for access" when it was added as
 * pending (or "Request declined" when the caller knows the request was declined), and
 * "Access removed" otherwise: the window keeps its slot and never silently disappears.
 */
export function sourceStatus(window: ViewWindow, ref: SourceRef, state: AccessState, declined = false): SourceStatus {
  if (state.kind === "signin") return "signin";
  if (state.kind === "needs-connection") return "needs-connection";
  if (state.kind !== "locked") return "ready";
  if (!(window.pending ?? []).includes(formatCanonical(ref))) return "removed";
  return declined ? "declined" : "waiting";
}

export function statusLabel(status: SourceStatus): string {
  switch (status) {
    case "ready":
      return "";
    case "waiting":
      return "Waiting for access";
    case "declined":
      return "Request declined";
    case "removed":
      return "Access removed";
    case "signin":
      return "Sign in required";
    case "needs-connection":
      return "Needs connection";
  }
}

/**
 * Drop pending marks for sources now positively readable, so a later revocation shows
 * "Access removed". Indeterminate states (signed out, needs connection) keep the mark.
 * Returns the same window when nothing changes.
 */
export function settlePending(window: ViewWindow, access: (ref: SourceRef) => AccessState): ViewWindow {
  if (!window.pending?.length) return window;
  const still = window.pending.filter((key) => {
    const ref = window.sources.find((s) => formatCanonical(s) === key);
    return ref ? access(ref).kind !== "read" : false;
  });
  if (still.length === window.pending.length) return window;
  const next: ViewWindow = { ...window };
  if (still.length) next.pending = still;
  else delete next.pending;
  return next;
}
