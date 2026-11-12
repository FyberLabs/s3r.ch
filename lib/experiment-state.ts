import { isSeaPubkey } from "./identity/forum-check";
import { randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { hashExperimentAssignment, type ExperimentPayload } from "./experiment-contract";

export const anonymousExperimentCookie = "__Host-s3rch-experiment-id";
export const experimentStateCookie = "__Host-s3rch-experiments";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const slug = /^[a-z][a-z0-9_-]{0,63}$/;
const digest = /^[0-9a-f]{64}$/;
const ttl = 365 * 24 * 60 * 60;
const maximum = 8;
type Assignment = { key: string; variant: string; hash: string };
type State = { anonymous: string; subject: string | null; assignments: Assignment[] };
export type ExperimentDefinition = Readonly<{ key: string; control: string; variants: readonly string[] }>;
function definition(value: ExperimentDefinition) {
  if (!value || typeof value.key !== "string" || !slug.test(value.key) || typeof value.control !== "string" || !slug.test(value.control) || !Array.isArray(value.variants) ||
      value.variants.length < 2 || value.variants.length > 8 || !value.variants.every(v => typeof v === "string" && slug.test(v)) ||
      new Set(value.variants).size !== value.variants.length || !value.variants.includes(value.control)) throw Error("Invalid experiment definition");
}
function readCookie(header: string, name: string) {
  if (header.length > 16384) return null;
  const matches = header.split(";").map(value => value.trim()).filter(value => value.startsWith(name + "="));
  return matches.length === 1 ? matches[0].slice(name.length + 1) : null;
}
function validState(value: unknown): value is State {
  if (!value || typeof value !== "object") return false;
  const row = value as State;
  return Object.keys(row).sort().join() === "anonymous,assignments,subject" && uuid.test(row.anonymous) &&
    (row.subject === null || typeof row.subject === "string" && digest.test(row.subject)) &&
    Array.isArray(row.assignments) && row.assignments.length <= maximum && row.assignments.every(item =>
      item && Object.keys(item).sort().join() === "hash,key,variant" && typeof item.key === "string" && slug.test(item.key) &&
      typeof item.variant === "string" && slug.test(item.variant) && typeof item.hash === "string" && digest.test(item.hash)) &&
    new Set(row.assignments.map(item => item.key)).size === row.assignments.length;
}

/** Server-only adapter. verifiedPrincipal must come from the SEA session
 * authenticator, never a body, cookie, wallet claim or browser-supplied key.
 * State affects experiments only; it never grants authorization. */
export function createExperimentState(input: { secret: Uint8Array; previousSecrets?: readonly Uint8Array[]; clock?: () => number }) {
  if (!(input.secret instanceof Uint8Array) || input.secret.byteLength < 32) throw Error("Experiment secret required");
  if (input.previousSecrets !== undefined && (!Array.isArray(input.previousSecrets) || input.previousSecrets.length > 3 ||
      input.previousSecrets.some(key => !(key instanceof Uint8Array) || key.byteLength < 32))) throw Error("Invalid previous experiment secrets");
  const previousSecrets = (input.previousSecrets ?? []).map(key => new Uint8Array(key));
  const secret = new Uint8Array(input.secret), clock = input.clock ?? (() => Math.floor(Date.now() / 1000));
  const type = "s3rch-experiment-state-v1";
  return async (cookieHeader: string, verifiedPrincipal: string | null, active: readonly ExperimentDefinition[]) => {
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0 || active.length > maximum) throw Error("Invalid experiment configuration");
    active.forEach(definition);
    active = active.map(value => Object.freeze({ ...value, variants: Object.freeze([...value.variants]) }));
    if (new Set(active.map(value => value.key)).size !== active.length) throw Error("Duplicate experiment");
    if (verifiedPrincipal !== null && (typeof verifiedPrincipal !== "string" || !isSeaPubkey(verifiedPrincipal))) throw Error("Invalid verified principal");
    const subject = verifiedPrincipal === null ? null : hashExperimentAssignment(verifiedPrincipal, secret);
    let anonymous = readCookie(cookieHeader, anonymousExperimentCookie);
    if (!anonymous || !uuid.test(anonymous)) anonymous = randomUUID();
    let state: State = { anonymous, subject, assignments: [] };
    const token = readCookie(cookieHeader, experimentStateCookie);
    let stateSecret = secret;
    if (token && token.length <= 3800) {
      for (const candidate of [secret, ...previousSecrets]) {
        try {
          const { payload } = await jwtVerify(token, candidate, { algorithms: ["HS256"], typ: type,
            issuer: "s3rch", audience: type, currentDate: new Date(now * 1000), requiredClaims: ["iat", "exp"] });
          if (validState(payload.state) && payload.state.anonymous === anonymous &&
              Number.isSafeInteger(payload.iat) && Number.isSafeInteger(payload.exp) && payload.iat! <= now && payload.exp! - payload.iat! === ttl) {
            state = payload.state;
            stateSecret = candidate;
            break;
          }
        } catch { /* Try only explicitly configured prior signing keys. */ }
      }
    }
    // Carry the anonymous cohort into the first authenticated session. A
    // logout or account switch must not carry another person's cohort forward.
    const previousSubject = verifiedPrincipal === null ? null : hashExperimentAssignment(verifiedPrincipal, stateSecret);
    if (state.subject !== null && state.subject !== previousSubject) {
      state = { anonymous: randomUUID(), subject, assignments: [] };
    }
    state.subject = subject;
    state.assignments = state.assignments.filter(item => active.some(value => value.key === item.key && value.variants.includes(item.variant)));
    const targetingKey = subject ?? hashExperimentAssignment(state.anonymous, secret);
    const inFlight = new Map<string, Promise<Assignment | undefined>>();
    return Object.freeze({
      async evaluate(key: string, choose: (targetingKey: string) => Promise<string>, guardrailHealthy = true): Promise<ExperimentPayload> {
        const config = active.find(value => value.key === key);
        if (!config) throw Error("Inactive experiment");
        let assigned = state.assignments.find(item => item.key === key);
        if (!assigned && guardrailHealthy) {
          let pending = inFlight.get(key);
          if (!pending) {
            pending = Promise.resolve().then(async () => {
              try {
                const variant = await choose(targetingKey);
                if (config.variants.includes(variant)) {
                  const value = { key, variant, hash: targetingKey };
                  state.assignments.push(value);
                  return value;
                }
              } catch { /* Provider absence uses control without saving a false assignment. */ }
              return undefined;
            }).finally(() => { inFlight.delete(key); });
            inFlight.set(key, pending);
          }
          assigned = await pending;
        }
        return Object.freeze({ experiment_key: key, variant: guardrailHealthy ? assigned?.variant ?? config.control : config.control,
          assignment_hash: assigned?.hash ?? targetingKey, surface: "s3r.ch" });
      },
      async cookies(): Promise<readonly string[]> {
        const token = await new SignJWT({ state }).setProtectedHeader({ alg: "HS256", typ: type })
          .setIssuer("s3rch").setAudience(type).setIssuedAt(now).setExpirationTime(now + ttl).sign(secret);
        if (token.length > 3800) throw Error("Experiment state exceeds cookie limit");
        const attributes = `; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${ttl}`;
        return Object.freeze([`${anonymousExperimentCookie}=${state.anonymous}${attributes}`, `${experimentStateCookie}=${token}${attributes}`]);
      },
    });
  };
}
