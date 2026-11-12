/** Client custody only. WebCrypto imports the locally unlocked SEA pair; neither
 * the pair nor a signing key is passed to the authority reader or HTTP client. */
import type { SeaPair } from "./identity/sea";
import { createForumAuthority, type ForumAuthorityConfig } from "./identity/forum-authority";
import { isForumObjectId, isSeaPubkey } from "./identity/forum-check";
import { parseForumAuthority } from "./identity/forum-authority-records";
import { assignmentCancellationIntents, assignmentReplacementIntents, type AssignmentSigningIntent } from "./assignment-signing-plan";
import { verifyAssignmentSignedMaterial } from "./assignment-signed-material";
import type { ForumAuthorityReader } from "./forum-authority-source";
import type { createDelegationRuntime } from "./delegation-runtime";
import type { AssignmentScope } from "./assignment-client";
type Plan = Awaited<ReturnType<ReturnType<typeof createDelegationRuntime>["plan"]>>;
export type AssignmentSigningRequest = AssignmentScope & { operationId: string; replacement: string; revision: number };
export type AssignmentSigningApproval = Readonly<AssignmentSigningRequest & { previous: string; destinations: readonly string[] }>;
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export async function signBrowserAssignment(input: {
  plan: unknown; requested: AssignmentSigningRequest; pair: SeaPair; config: ForumAuthorityConfig;
  read: ForumAuthorityReader; signal: AbortSignal; approve: (preview: AssignmentSigningApproval) => Promise<boolean>;
  clock?: () => number;
}) {
  const plan = structuredClone(input.plan) as Plan, requested = structuredClone(input.requested), pair = { ...input.pair }, config = structuredClone(input.config);
  const clock = input.clock ?? (() => Math.floor(Date.now() / 1000));
  input.signal.throwIfAborted();
  if (!plan || Object.keys(plan).sort().join() !== "cancellations,forum,grants,issuedAt,operationId,owner,previous,replacement,revision,version" ||
      plan.version !== 1 || plan.forum !== requested.forum || plan.owner !== requested.owner || plan.operationId !== requested.operationId ||
      plan.replacement !== requested.replacement || plan.revision !== requested.revision || !isForumObjectId(plan.forum, "forum") ||
      !isSeaPubkey(plan.owner) || !isSeaPubkey(plan.previous) || !isSeaPubkey(plan.replacement) || !isSeaPubkey(pair.pub) ||
      plan.previous === plan.replacement || plan.owner === plan.replacement || !/^[0-9a-f]{32}$/.test(plan.operationId) ||
      !Number.isSafeInteger(plan.revision) || plan.revision < 0 || !Number.isSafeInteger(plan.issuedAt) || plan.issuedAt < 0 ||
      !Array.isArray(plan.cancellations) || plan.cancellations.length < 2 || plan.cancellations.length > 192 ||
      !Array.isArray(plan.grants) || plan.grants.length < 2 || plan.grants.length > 128 || JSON.stringify(plan).length > 524288)
    throw Error("Invalid assignment signing plan");
  const destinations = [...new Set(plan.cancellations.filter(i => i?.kind === "post").map(i => i.fields?.object))];
  if (!destinations.length || destinations.length > 64 || destinations.some(object => !isForumObjectId(object))) throw Error("Invalid assignment signing targets");
  const preview = Object.freeze({ ...requested, previous: plan.previous, destinations: Object.freeze(destinations as string[]) });
  if (!await input.approve(preview)) throw Error("Assignment signing canceled");
  input.signal.throwIfAborted();
  const at = clock();
  if (plan.issuedAt > at || at - plan.issuedAt > 300) throw Error("Assignment signing plan expired");
  const received = await input.read(at, input.signal);
  const snapshot = received ? structuredClone(received) : null;
  if (!snapshot) throw Error("Assignment signing authority unavailable");
  const authority = createForumAuthority(config, clock), admitted = await authority.refresh(snapshot, at);
  if (!admitted.ok || admitted.diagnostics.length || clock() !== at || authority.graph.ownerOf(plan.forum) !== plan.owner ||
      authority.graph.writerKey(plan.owner, plan.issuedAt, at) !== pair.pub || destinations.some(object => authority.graph.ownerOf(object as string) !== plan.owner))
    throw Error("Assignment signing authority changed");
  const state = { owner: plan.owner, rows: snapshot.rows, destinations: destinations as string[] };
  const expected = { issuedAt: plan.issuedAt,
    cancellations: await assignmentCancellationIntents(state, plan.operationId, plan.previous, plan.issuedAt, authority.graph, at),
    grants: assignmentReplacementIntents(state, plan.replacement, plan.issuedAt) };
  for (const phase of ["cancellations", "grants"] as const) {
    if (plan[phase].length !== expected[phase].length) throw Error("Assignment signing plan changed");
    for (let i = 0; i < expected[phase].length; i++) {
      const supplied = plan[phase][i], wanted = expected[phase][i];
      const p = supplied && parseForumAuthority(supplied.kind, { ...supplied.fields, sig: "pending" });
      const e = parseForumAuthority(wanted.kind, { ...wanted.fields, sig: "pending" })!;
      if (!p || supplied.kind !== wanted.kind || supplied.soul !== wanted.soul || p.bytes.length !== e.bytes.length ||
          p.bytes.some((byte, j) => byte !== e.bytes[j])) throw Error("Assignment signing plan changed");
    }
  }
  input.signal.throwIfAborted();
  if (clock() !== at) throw Error("Assignment signing authority expired");
  const [x, y] = pair.pub.split(".");
  const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x, y, d: pair.priv, ext: false, key_ops: ["sign"] }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sign = async (intents: readonly AssignmentSigningIntent[]) => {
    const rows = [];
    for (const intent of intents) {
      input.signal.throwIfAborted();
      const parsed = parseForumAuthority(intent.kind, { ...intent.fields, sig: "pending" })!;
      const sig = b64(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new Uint8Array(parsed.bytes))));
      rows.push({ kind: intent.kind, soul: intent.soul, record: { ...intent.fields, sig } });
    }
    return rows;
  };
  const material = { issuedAt: plan.issuedAt, cancellations: await sign(expected.cancellations), grants: await sign(expected.grants) };
  input.signal.throwIfAborted();
  if (clock() !== at) throw Error("Assignment signing authority expired");
  return verifyAssignmentSignedMaterial(material, expected, authority.graph, at);
}
