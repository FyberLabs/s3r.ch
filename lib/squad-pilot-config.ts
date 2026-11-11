import { p256 } from "@noble/curves/nist.js";
import { squadView, type LiveSquadSpec } from "./squad-view";
import type { ForumAuthorityConfig } from "./identity/forum-authority";

import type { ReportParents } from "./forum-report-forward";

export type SquadPilotConfig = Readonly<{
  version: 1; origin: string; squad: LiveSquadSpec; authority: ForumAuthorityConfig;
  reportParents?: ReportParents;
  ownerSigningKey: string;
}>;
const exact = (x: unknown, keys: string): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x) && Object.keys(x).sort().join() === keys;
const strings = (x: unknown): x is string[] => Array.isArray(x) && x.length <= 32 && x.every(s => typeof s === "string" && s.length > 0 && s.length <= 2048) && new Set(x).size === x.length;
/** Secret-backed deployment contract. Missing means disabled; malformed never
 * falls back to fixture identities, local credentials or permissive policy. */
export function parseSquadPilotConfig(raw: string | undefined): SquadPilotConfig | null {
  try { return parse(raw); } catch { throw Error("invalid Squad pilot configuration"); }
}
function parse(raw: string | undefined): SquadPilotConfig | null {
  if (raw === undefined || raw === "") return null;
  if (Buffer.byteLength(raw) > 24576) throw Error("invalid Squad pilot configuration");
  const c: unknown = JSON.parse(raw);
  // Older moving-channel deployment documents may still carry this obsolete
  // field. Validate and discard it; it never selects a signing secret.
  if (c && typeof c === "object" && !Array.isArray(c) && "sessionSecret" in c) {
    if (typeof c.sessionSecret !== "string" || !/^[0-9a-f]{64}$/.test(c.sessionSecret)) throw Error("invalid obsolete session secret");
    delete (c as { sessionSecret?: unknown }).sessionSecret;
  }
  if ((!exact(c, "authority,origin,ownerSigningKey,squad,version") &&
      !exact(c, "authority,origin,ownerSigningKey,reportParents,squad,version")) || c.version !== 1 ||
      typeof c.origin !== "string" || new URL(c.origin).origin !== c.origin || !c.origin.startsWith("https://") ||
      !exact(c.squad, "forumId,label,owner") || !exact(c.authority, "keys,pinnedIssuers,policy") ||
      !exact(c.authority.policy, "allowedChainIds,allowedDomains,allowedUris") ||
      !strings(c.authority.policy.allowedChainIds) || !strings(c.authority.policy.allowedDomains) || !strings(c.authority.policy.allowedUris) ||
      !strings(c.authority.pinnedIssuers) || !Array.isArray(c.authority.keys) || c.authority.keys.length < 1 || c.authority.keys.length > 16 ||
      typeof c.ownerSigningKey !== "string" || !/^[0-9a-f]{64}$/.test(c.ownerSigningKey)) throw Error("invalid Squad pilot configuration");
  const keys = new Set<string>(), material = new Set<string>();
  for (const k of c.authority.keys) {
    if (!exact(k, "crv,kid,kty,notAfter,notBefore,x,y") || k.kty !== "EC" || k.crv !== "P-256" ||
        typeof k.kid !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(k.kid) || keys.has(k.kid) ||
        typeof k.x !== "string" || typeof k.y !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(k.x) || !/^[A-Za-z0-9_-]{43}$/.test(k.y) ||
        !Number.isSafeInteger(k.notBefore) || !Number.isSafeInteger(k.notAfter) || (k.notBefore as number) < 0 || (k.notAfter as number) <= (k.notBefore as number)) throw Error("invalid Squad witness policy");
    const publicKey = k.x + "." + k.y;
    if (material.has(publicKey) || publicKey === c.squad.owner) throw Error("pilot witness must have independent key material");
    material.add(publicKey); keys.add(k.kid);
    p256.Point.fromBytes(Buffer.concat([Buffer.from([4]), Buffer.from(k.x, "base64url"), Buffer.from(k.y, "base64url")]));
  }
  const typed = c as unknown as SquadPilotConfig;
  squadView(typed.squad);
  if ("reportParents" in typed) {
    const parents = typed.reportParents;
    if (!exact(parents, "command,fleet")) throw Error("invalid report destinations");
    const ids = new Set([typed.squad.forumId]);
    for (const parent of [parents.fleet, parents.command]) {
      if (!parent || !squadView(parent).live || ids.has(parent.forumId) || material.has(parent.owner))
        throw Error("invalid report destination");
      ids.add(parent.forumId);
    }
  }
  // Validate scalar encoding here. The runtime resolves the owner's current
  // key from the ledger before admitting signed ACL mutations, so a rotated
  // owner can replace this secret without changing its stable principal.
  p256.getPublicKey(Buffer.from(typed.ownerSigningKey, "hex"), false);
  return structuredClone(typed);
}
export function publicSquadPilotConfig(c: SquadPilotConfig) {
  return structuredClone({ ...(c.reportParents ? { reportParents: c.reportParents } : {}), origin: c.origin, squad: c.squad, config: c.authority,
    sessionBase: "/api/squad/pilot/session", authorityEndpoint: "/api/squad/pilot/authority", assignmentBase: "/api/squad/pilot/assignment" });
}
