import { AsyncLocalStorage } from "node:async_hooks";
import { terminalRuntimeConfig } from "./terminal-runtime-config";
import type { createTerminalServingRouter } from "./terminal-serving-router";
type Native = () => Promise<Response>;
type Router = Awaited<ReturnType<typeof createTerminalServingRouter>>;
const key = Symbol.for("s3rch.terminal.router.v1");
const shared = globalThis as typeof globalThis & { [key]?: { native: AsyncLocalStorage<Native>; router: Promise<Router> } };
const refused = () => Response.json({ error: "unavailable" }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
/** Every route bundle shares only immutable configuration and request-local ALS. */
export async function configuredTerminalRequest(request: Request, native: Native): Promise<Response> {
  try {
    const snapshot = terminalRuntimeConfig();
    if (!snapshot.config) return await native();
    if (!shared[key]) {
      const callbacks = new AsyncLocalStorage<Native>(), env = Object.freeze({ ...process.env });
      const router = import("./terminal-serving-router").then(module => module.createTerminalServingRouter({
        config: snapshot.raw!, env, experimentsEnabled: env.S3RCH_EXPERIMENTS_ENABLED === "1",
      }, async () => {
        const current = callbacks.getStore();
        if (!current) throw Error("Native request context unavailable");
        return current();
      }));
      shared[key] = { native: callbacks, router };
    }
    const state = shared[key];
    return await state.native.run(native, async () => (await state.router).request(request));
  } catch { return refused(); }
}
export function withConfiguredTerminalHandler<A extends unknown[]>(native: (request: Request, ...args: A) => Response | Promise<Response>) {
  return (request: Request, ...args: A): Promise<Response> => configuredTerminalRequest(request, async () => native(request, ...args));
}
