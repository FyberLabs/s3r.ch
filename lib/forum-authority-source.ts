import type { StatementAdmission } from "./forum-statement-browser";
import type { AssignmentClient } from "./assignment-client";
import type { ForumAuthorityConfig, ForumAuthoritySnapshot } from "./identity/forum-authority";

export type ForumAuthoritySource = Readonly<{
  config: ForumAuthorityConfig;
  assignments?: AssignmentClient;
  admitStatement?: StatementAdmission;
  subscribe(receive: (snapshot: ForumAuthoritySnapshot | null, at: number) => void): () => void;
}>;

/** The reader is a provisioned, authenticated complete-history transport, never
 * a Gun subscription or a peer completeness claim. It must take an atomic view
 * of history and ACL evidence and honor cancellation. This adapter provides
 * freshness/lifecycle only; createForumAuthority still verifies every record.
 */
export type ForumAuthorityReader = (at: number, signal: AbortSignal) => Promise<ForumAuthoritySnapshot | null>;

export function createForumAuthoritySource(options: Readonly<{
  config: ForumAuthorityConfig;
  read: ForumAuthorityReader;
  assignments?: AssignmentClient;
}>): ForumAuthoritySource {
  // Pin trust policy for this source's lifetime. Rotation creates a new source
  // so the provider invalidates its previous graph and in-flight verification.
  const config = structuredClone(options.config);
  function freeze(value: object) {
    for (const child of Object.values(value)) if (child && typeof child === "object") freeze(child);
    Object.freeze(value);
  }
  freeze(config);
  const { read, assignments } = options;
  return Object.freeze({ config, assignments,
    subscribe(receive) {
      let active = true;
      let last = -1;
      let pending: AbortController | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      function cancel() {
        pending?.abort(); pending = undefined;
        clearTimeout(deadline); deadline = undefined;
      }
      function tick() {
        const at = Math.floor(Date.now() / 1000);
        if (!active || at === last) return;
        cancel();
        receive(null, at);
        // A backward clock never revives a previously evaluated generation.
        if (at < last) return;
        last = at;
        const request = new AbortController(); pending = request;
        const current = () => active && pending === request && !request.signal.aborted && Math.floor(Date.now() / 1000) === at;
        deadline = setTimeout(() => {
          if (pending !== request) return;
          cancel();
          if (active) receive(null, Math.floor(Date.now() / 1000));
        }, 800);
        void Promise.resolve().then(() => {
          if (!current()) return null;
          return read(at, request.signal);
        }).then(snapshot => {
          if (!current()) return;
          clearTimeout(deadline); deadline = undefined;
          // Never restamp an old response or extend a completeness horizon.
          if (!snapshot || snapshot.completeThrough < at || snapshot.history.completeThrough < at) return;
          receive(snapshot, at);
        }).catch(() => {
          if (!current()) return;
          cancel(); receive(null, at);
        });
      }
      const timer = setInterval(tick, 100);
      tick();
      return () => { active = false; clearInterval(timer); cancel(); };
    },
  });
}
