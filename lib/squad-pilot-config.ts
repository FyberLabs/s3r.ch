import { p256 } from "@noble/curves/nist.js";
import { squadView, type LiveSquadSpec } from "./squad-view";
import type { ForumAuthorityConfig } from "./identity/forum-authority";

import { parseSquadPlaneConfig, type SquadPlaneConfig } from "./squad-plane-forum";
import type { ReportParents } from "./forum-report-forward";

export type SquadPilotConfig = Readonly<{
  version: 1; origin: string; squad: LiveSquadSpec; authority: ForumAuthorityConfig;
  reportParents?: ReportParents;
  plane?: SquadPlaneConfig;
  project?: Readonly<{ recordOrigin: string; recordKey?: string; fixtureCleanup?: true }>;
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
  // Moving-channel documents may still contain the retired field. Discard it
  // without importing a private key; provisioning must remove it from the vault.
  if (c && typeof c === "object" && !Array.isArray(c) && "ownerSigningKey" in c) {
    if (typeof c.ownerSigningKey !== "string" || !/^[0-9a-f]{64}$/.test(c.ownerSigningKey)) throw Error("invalid obsolete owner key");
    delete (c as { ownerSigningKey?: unknown }).ownerSigningKey;
  }
  if (!c || typeof c !== "object" || Array.isArray(c) ||
      Object.keys(c).some(key => !["authority", "origin", "plane", "project", "reportParents", "squad", "version"].includes(key)))
    throw Error("invalid Squad pilot configuration");
  const row = c as Record<string, unknown>;
  if (row.version !== 1 ||
      typeof row.origin !== "string" || new URL(row.origin).origin !== row.origin || !row.origin.startsWith("https://") ||
      !exact(row.squad, "forumId,label,owner") || !exact(row.authority, "keys,pinnedIssuers,policy") ||
      !exact(row.authority.policy, "allowedChainIds,allowedDomains,allowedUris") ||
      !strings(row.authority.policy.allowedChainIds) || !strings(row.authority.policy.allowedDomains) || !strings(row.authority.policy.allowedUris) ||
      !strings(row.authority.pinnedIssuers) || !Array.isArray(row.authority.keys) || row.authority.keys.length < 1 || row.authority.keys.length > 16) throw Error("invalid Squad pilot configuration");
  if ("project" in row) {
    const project = row.project;
    const fixture = (exact(project, "fixtureCleanup,recordOrigin") ||
      exact(project, "fixtureCleanup,recordKey,recordOrigin")) &&
      project.fixtureCleanup === true && row.origin === "https://test.s3r.ch";
    if (!("plane" in row) || (!fixture && !exact(project, "recordKey,recordOrigin")) ||
        typeof project.recordOrigin !== "string" || !project.recordOrigin.startsWith("https://") ||
        new URL(project.recordOrigin).origin !== project.recordOrigin || new URL(project.recordOrigin).port ||
        ("recordKey" in project && (typeof project.recordKey !== "string" ||
          !/^[\x21-\x7e]{1,4096}$/.test(project.recordKey))))
      throw Error("invalid Squad project configuration");
  }
  const keys = new Set<string>(), material = new Set<string>();
  for (const k of row.authority.keys) {
    if (!exact(k, "crv,kid,kty,notAfter,notBefore,x,y") || k.kty !== "EC" || k.crv !== "P-256" ||
        typeof k.kid !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(k.kid) || keys.has(k.kid) ||
        typeof k.x !== "string" || typeof k.y !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(k.x) || !/^[A-Za-z0-9_-]{43}$/.test(k.y) ||
        !Number.isSafeInteger(k.notBefore) || !Number.isSafeInteger(k.notAfter) || (k.notBefore as number) < 0 || (k.notAfter as number) <= (k.notBefore as number)) throw Error("invalid Squad witness policy");
    const publicKey = k.x + "." + k.y;
    if (material.has(publicKey) || publicKey === row.squad.owner) throw Error("pilot witness must have independent key material");
    material.add(publicKey); keys.add(k.kid);
    p256.Point.fromBytes(Buffer.concat([Buffer.from([4]), Buffer.from(k.x, "base64url"), Buffer.from(k.y, "base64url")]));
  }
  const typed = c as unknown as SquadPilotConfig;
  squadView(typed.squad);
  if ("plane" in typed) parseSquadPlaneConfig(typed.plane);
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
  return structuredClone(typed);
}
export function publicSquadPilotConfig(c: SquadPilotConfig) {
  return structuredClone({ ...(c.project ? { projectEnabled: true } : {}), ...(c.plane?.controlCredential ? { planeBotControls: true } : {}), ...(c.reportParents ? { reportParents: c.reportParents } : {}), origin: c.origin, squad: c.squad, config: c.authority,
    sessionBase: "/api/identity/sea", authorityEndpoint: "/api/squad/pilot/authority", statementEndpoint: "/api/squad/pilot/statement",
    visorCompanionEndpoint: "/api/squad/pilot/visor-companion" });
}
