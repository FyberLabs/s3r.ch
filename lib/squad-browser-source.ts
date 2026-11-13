import type { AssignmentSigningRequest } from "./assignment-browser-sign";
import type { ForumAuthorityReader } from "./forum-authority-source";
import { createForumAuthoritySource, type ForumAuthoritySource } from "./forum-authority-source";
import { createHttpForumAuthorityReader } from "./forum-authority-http";
import { createHttpAssignmentClient, type AssignmentClient, type AssignmentScope } from "./assignment-client";
import type { ForumAuthorityConfig } from "./identity/forum-authority";
import { squadView, type LiveSquadSpec } from "./squad-view";

/** Browser-owned lifecycle. Activate only after the chosen SEA session exchange;
 * deactivate synchronously on logout/key change. Enabling is transport permission,
 * never proof of authority; server and provider still verify each request/record. */
export function createSquadBrowserSource(input: {
  squad: LiveSquadSpec; config: ForumAuthorityConfig; authorityEndpoint: string; assignmentBase?: string; fetch?: typeof fetch;
  signPlan?: (plan: unknown, requested: AssignmentSigningRequest, context: { read: ForumAuthorityReader; signal: AbortSignal }) => Promise<unknown>;
}) {
  const view = squadView(input.squad);
  if (!view.live || (input.assignmentBase !== undefined && (!/^\/[A-Za-z0-9/_-]+$/.test(input.assignmentBase) || input.assignmentBase.startsWith("//")))) throw Error("Explicit live endpoints required");
  const fetcher = input.fetch ?? fetch;
  let enabled = false, disposed = false, generation = 0, controller = new AbortController();
  const transport: typeof fetch = async (url, init) => {
    if (!enabled || disposed) throw Error("Squad session inactive");
    const epoch = generation;
    const response = await fetcher(url, { ...init, mode: "same-origin", redirect: "error", credentials: "same-origin", cache: "no-store",
      signal: init?.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal });
    if (!enabled || disposed || generation !== epoch) { await response.body?.cancel(); throw Error("Squad session changed"); }
    return response;
  };
  const read = createHttpForumAuthorityReader({ endpoint: input.authorityEndpoint, squad: input.squad, fetch: transport });
  const client = input.assignmentBase ? createHttpAssignmentClient({ base: input.assignmentBase.replace(/\/$/, ""), fetch: transport,
    ...(input.signPlan ? { signPlan: async (plan: unknown, requested: AssignmentSigningRequest) => {
      const epoch = generation, signal = controller.signal;
      if (!enabled || disposed) throw Error("Squad session inactive");
      const material = await input.signPlan!(plan, requested, { read, signal });
      if (!enabled || disposed || generation !== epoch) throw Error("Squad session changed");
      return material;
    } } : {}) }) : undefined;
  async function scoped<T>(scope: AssignmentScope, perform: () => Promise<T>): Promise<T> {
    if (!enabled || disposed || scope.forum !== view.forumId || scope.owner !== view.owner) throw Error("Inactive or mismatched Squad scope");
    const epoch = generation, result = await perform();
    if (!enabled || disposed || generation !== epoch) throw Error("Squad session changed");
    return result;
  }
  const assignments: AssignmentClient | undefined = client ? Object.freeze({
    read: scope => scoped(scope, () => client.read(scope)),
    start: (scope, id, replacement, revision) => scoped(scope, () => client.start(scope, id, replacement, revision)),
    resume: (scope, id, replacement) => scoped(scope, () => client.resume(scope, id, replacement)),
    abort: (scope, id) => scoped(scope, () => client.abort(scope, id)),
    readChild: (scope, id) => scoped(scope, () => client.readChild(scope, id)),
    publishChild: (scope, record, signature) => scoped(scope, () => client.publishChild(scope, record, signature)),
  }) : undefined;
  const upstream = createForumAuthoritySource({ config: input.config, assignments,
    read });
  const subscriptions = new Set<{ receive: Parameters<ForumAuthoritySource["subscribe"]>[0]; stop?: () => void }>();
  function deactivate() {
    enabled = false; generation++; controller.abort();
    for (const sub of subscriptions) { sub.stop?.(); sub.stop = undefined; sub.receive(null, Math.floor(Date.now() / 1000)); }
  }
  const source: ForumAuthoritySource = Object.freeze({ config: upstream.config, assignments,
    subscribe(receive) {
      const sub: { receive: typeof receive; stop?: () => void } = { receive };
      receive(null, Math.floor(Date.now() / 1000));
      if (disposed) return () => {};
      subscriptions.add(sub);
      if (enabled) sub.stop = upstream.subscribe(receive);
      return () => { sub.stop?.(); subscriptions.delete(sub); };
    },
  });
  return Object.freeze({ source, deactivate,
    activate() {
      if (disposed) throw Error("Squad source disposed");
      if (enabled) return;
      controller = new AbortController(); generation++; enabled = true;
      for (const sub of subscriptions) sub.stop = upstream.subscribe(sub.receive);
    },
    dispose() { if (!disposed) { disposed = true; deactivate(); subscriptions.clear(); } },
  });
}
