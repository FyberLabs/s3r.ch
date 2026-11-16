import { AsyncLocalStorage } from "node:async_hooks";

export type RunBinding = Readonly<{ run: string; generation: string }>;
export type RunAdmission = Readonly<{ binding: RunBinding; operation: string }>;
export type RunToken = Readonly<{ kind: string; subject: string | null }>;
/** Server-owned adapter. admit must reject a missing grant for fixture scope;
 * null is reserved for positively identified unrelated traffic. No cached reads.
 * Pending admission is durable before work. complete may not infer remote rollback.
 * authorizeToken resolves native identities from registered fixture policy, never
 * from a child-supplied label (SEA keys are not Keycloak subject UUIDs).
 */
export interface TerminalRunAuthority {
  admit(request: Request): Promise<RunAdmission | null>;
  active(admission: RunAdmission): Promise<boolean>;
  authorizeToken(admission: RunAdmission, token: RunToken): Promise<boolean>;
  complete(admission: RunAdmission): Promise<void>;
}
type Context = { authority: TerminalRunAuthority; admission: RunAdmission | null; closed: boolean };
const context = new AsyncLocalStorage<Context>();
const fail = (): never => { throw Error("Terminal run authority unavailable"); };
function binding(value: unknown): RunBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join() !== "generation,run" || typeof row.run !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(row.run) || typeof row.generation !== "string" || !/^[a-f0-9]{64}$/.test(row.generation)) return fail();
  return Object.freeze({ run: row.run, generation: row.generation });
}
async function active(value: Context) {
  if (value.closed) fail();
  if (value.admission && await value.authority.active(value.admission) !== true) fail();
  if (value.closed) fail();
}
/** The caller supplies a native success predicate. Error responses, swallowed
 * failures and unknown remote outcomes must return false. No finally completion.
 * This function is not installed on production routes until all owner contracts
 * and the fixture credential bypass inventory are complete.
 */
export async function withTerminalRun<T>(request: Request, authority: TerminalRunAuthority,
  work: () => Promise<T>, completed: (result: T) => boolean): Promise<T> {
  if (context.getStore()) return fail();
  const admitted = await authority.admit(request);
  const admission = admitted === null ? null : Object.freeze({ binding: binding(admitted.binding), operation: admitted.operation });
  if (admission && (typeof admission.operation !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(admission.operation))) return fail();
  const current = { authority, admission, closed: false };
  return context.run(current, async () => {
    try {
      await active(current);
      const result = await work();
      // Fence detached continuations before acknowledging completion. A seal
      // racing already-admitted work must still be able to drain that work.
      current.closed = true;
      if (admission && completed(result) === true) await authority.complete(admission);
      if (admission && await authority.active(admission) !== true) fail();
      return result;
    } finally { current.closed = true; }
  });
}
async function tokenContext(token: RunToken) {
  const current = context.getStore();
  if (current?.admission) {
    await active(current);
    if (await current.authority.authorizeToken(current.admission, Object.freeze({ ...token })) !== true) fail();
    await active(current);
  }
  if (current?.closed) fail();
  return current;
}
/** Called before signing. The binding is copied from authenticated admission. */
export async function terminalTokenClaims(token: RunToken): Promise<Record<string, unknown>> {
  const current = await tokenContext(token);
  if (current?.closed) fail();
  return current?.admission ? { nightly_run: { ...current.admission.binding } } : {};
}
/** Called after cryptographic verification, including pending challenges.
 * A bound token cannot silently fall back to a legacy/uninstalled verifier.
 */
export async function verifyTerminalToken(claims: Record<string, unknown>, token: RunToken): Promise<void> {
  const current = context.getStore(), supplied = claims.nightly_run;
  if (supplied === undefined) {
    if (current?.admission) fail();
    return;
  }
  const original = binding(supplied);
  if (!current?.admission || original.run !== current.admission.binding.run || original.generation !== current.admission.binding.generation) fail();
  await tokenContext(token);
  if (current?.closed) fail();
}

/** Persistent work inherits admission, not caller labels. Already-admitted work
 * may drain after seal; the durable pending operation fences terminal completion.
 * This does not authorize new requests or token issuance after seal. */
export function terminalWorkBinding(): RunBinding | undefined {
  const current = context.getStore();
  if (current?.closed) return fail();
  return current?.admission ? { ...current.admission.binding } : undefined;
}
export function verifyTerminalWork(original: unknown): void {
  const current = terminalWorkBinding();
  if (original === undefined) { if (current) fail(); return; }
  const saved = binding(original);
  if (!current || saved.run !== current.run || saved.generation !== current.generation) fail();
}
