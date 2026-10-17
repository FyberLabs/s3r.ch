/**
 * Targeted composer for View windows (docs/views.md §4, PR 5). The composer belongs to a
 * window; merged feed windows and read-only sources have none. In a tabbed window the
 * target is required and shown; one send goes to one source, never to all.
 */
import { CHAT_BODY_MAX } from "./chat";
import type { AccessState } from "./views-access";
import { sameSource, type SourceRef } from "./views-source-ref";
import type { ViewWindow } from "./views-window";

/** Whether the user can post to a source now. */
export function canPostTo(state: AccessState): boolean {
  return state.kind === "read" && state.post;
}

/** Sources the composer can target, in window order. Merged windows have no composer. */
export function composerTargets(window: ViewWindow, access: (ref: SourceRef) => AccessState): SourceRef[] {
  if (window.mode === "merged") return [];
  return window.sources.filter((r) => canPostTo(access(r)));
}

/**
 * The target to use: the source of the message being replied to, else the last source the
 * user replied to, else the first postable source. Returns null when nothing is postable or
 * the reply's source cannot be posted to (the user must pick).
 */
export function chooseTarget(targets: SourceRef[], opts: { replyTo?: SourceRef; last?: SourceRef } = {}): SourceRef | null {
  if (opts.replyTo) return targets.find((t) => sameSource(t, opts.replyTo!)) ?? null;
  if (opts.last) {
    const last = targets.find((t) => sameSource(t, opts.last!));
    if (last) return last;
  }
  return targets[0] ?? null;
}

export type SendCheck = { ok: true; target: SourceRef; text: string } | { ok: false; error: string };

/**
 * Validate a send: one postable target from this window and a nonempty message. The default
 * limit is the native chat and forum limit, the only sources postable for now.
 */
export function checkSend(targets: SourceRef[], target: SourceRef | null, text: string, maxLength = CHAT_BODY_MAX): SendCheck {
  const body = text.trim();
  if (!target) return { ok: false, error: "Choose where to post" };
  if (!targets.some((t) => sameSource(t, target))) return { ok: false, error: "You can't post to that source" };
  if (!body) return { ok: false, error: "Message is empty" };
  if (body.length > maxLength) return { ok: false, error: `Message is longer than ${maxLength} characters` };
  return { ok: true, target, text: body };
}
