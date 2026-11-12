import { isSeaPubkey } from "./forum-check";
import { isSeaPair, type SeaPair } from "./sea";

export type StartupOrganization = Readonly<{
  slug: string; id: string; tenant_id: string; roles: readonly string[];
}>;
/** Server-authenticated configuration, never values supplied by the login response. */
export type StartupLoginBinding = Readonly<{
  binding_sha256: string; mapping_sha256: string; sea_public_key: string;
  tenant_id: string; network_id: string; entra: Readonly<{ tenant_id: string; object_id: string }>;
  organizations: readonly StartupOrganization[];
}>;
export type StartupLinkedIdentity = StartupLoginBinding & Readonly<{
  person_id: string; broker_subject: string;
}>;
const slugs = ["fyberlabs", "hyperme.sh", "tennesseewindage"];
const uuid = (value: unknown): value is string => typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) &&
  value !== "00000000-0000-0000-0000-000000000000";
const hash = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const subject = (value: unknown): value is string => typeof value === "string" && /^[\x21-\x7e]{1,255}$/.test(value);

export function snapshotStartupLoginBinding(value: unknown): StartupLoginBinding | null {
  if (!object(value) || !hash(value.binding_sha256) || !hash(value.mapping_sha256) ||
      typeof value.sea_public_key !== "string" || !isSeaPubkey(value.sea_public_key) || !uuid(value.tenant_id) ||
      typeof value.network_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/.test(value.network_id) ||
      !object(value.entra) || !uuid(value.entra.tenant_id) || !uuid(value.entra.object_id) ||
      !Array.isArray(value.organizations) || value.organizations.length !== 3) return null;
  const organizations: StartupOrganization[] = [];
  for (let index = 0; index < slugs.length; index++) {
    const row = value.organizations[index];
    if (!object(row) || row.slug !== slugs[index] || !uuid(row.id) || row.tenant_id !== value.tenant_id ||
        organizations.some(other => other.id === row.id) || !Array.isArray(row.roles) ||
        row.roles.length < 1 || row.roles.length > 2 ||
        row.roles.some((role, i, all) => (role !== "admin" && role !== "owner") || (i > 0 && all[i - 1] >= role))) return null;
    organizations.push(Object.freeze({ slug: row.slug, id: row.id, tenant_id: row.tenant_id,
      roles: Object.freeze([...row.roles]) }));
  }
  return Object.freeze({ binding_sha256: value.binding_sha256, mapping_sha256: value.mapping_sha256,
    sea_public_key: value.sea_public_key, tenant_id: value.tenant_id, network_id: value.network_id,
    entra: Object.freeze({ tenant_id: value.entra.tenant_id, object_id: value.entra.object_id }),
    organizations: Object.freeze(organizations) });
}

/** Resolve linked credential metadata only. This never grants a SociACL action.
 * Auth has already verified the broker access token; verifiedSubject comes from
 * the authenticated OIDC exchange, not an email, query parameter or this response.
 */
export function resolveStartupLinkedIdentity(value: unknown, expected: StartupLoginBinding,
  verifiedSubject: string, existing: Readonly<{ sea_public_key: string; person_id?: string }>): StartupLinkedIdentity | null {
  const desired = snapshotStartupLoginBinding(expected), actual = snapshotStartupLoginBinding(value);
  if (!desired || !actual || !object(value) || value.schema_version !== 1 || value.status !== "resolved" ||
      !Array.isArray(value.permissions) || value.permissions.length !== 0 || !uuid(value.person_id) ||
      !subject(verifiedSubject) || value.broker_subject !== verifiedSubject ||
      existing.sea_public_key !== desired.sea_public_key ||
      (existing.person_id !== undefined && existing.person_id !== value.person_id) ||
      JSON.stringify(desired) !== JSON.stringify(actual)) return null;
  return Object.freeze({ ...actual, person_id: value.person_id, broker_subject: verifiedSubject });
}

/** Browser coordination uses an existing unlocked key; it has no key factory or
 * user/org writer. A logout, lock or key replacement fences an in-flight lookup.
 */
export function createStartupLinkedLogin(input: {
  expected: StartupLoginBinding;
  currentKey(): SeaPair | null;
  /** Increments on every lock, unlock or replacement, even if the same pair returns. */
  keyRevision(): number;
  lookup(): Promise<{ identity: unknown; verifiedSubject: string }>;
  existingPersonId?: string;
}) {
  const expected = snapshotStartupLoginBinding(input.expected);
  let generation = 0;
  let current: StartupLinkedIdentity | null = null;
  let linkedPerson = input.existingPersonId;
  let held: SeaPair | null = null, revision = -1;
  return Object.freeze({
    current(): StartupLinkedIdentity | null {
      const pair = input.currentKey();
      if (!current || !pair || pair !== held || input.keyRevision() !== revision ||
          !isSeaPair(pair) || pair.pub !== current.sea_public_key) { current = null; return null; }
      return current;
    },
    logout() { generation++; current = null; },
    async login(): Promise<StartupLinkedIdentity | null> {
      const attempt = ++generation;
      current = null;
      const pair = input.currentKey(), keyRevision = input.keyRevision();
      if (!Number.isSafeInteger(keyRevision) || keyRevision < 0 || !expected || !pair || !isSeaPair(pair) || pair.pub !== expected.sea_public_key) return null;
      try {
        const result = await input.lookup();
        if (attempt !== generation || input.currentKey() !== pair || input.keyRevision() !== keyRevision || pair.pub !== expected.sea_public_key) return null;
        const identity = resolveStartupLinkedIdentity(result.identity, expected, result.verifiedSubject,
          { sea_public_key: pair.pub, person_id: linkedPerson });
        if (!identity) return null;
        linkedPerson = identity.person_id;
        held = pair; revision = keyRevision;
        current = identity;
        return identity;
      } catch { return null; }
    },
  });
}
