import { createHash, createPublicKey } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { findOidcProvider, type OidcProvider } from "./providers";
import { snapshotStartupLoginBinding, type StartupLoginBinding } from "./startup-linked-login";

export type StartupLoginConfig = Readonly<{ binding: StartupLoginBinding; provider: OidcProvider; alias: string; endpoint: string }>;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function fields(value: unknown, names: string[]): value is Record<string, unknown> {
  return object(value) && Object.keys(value).sort().join() === names.sort().join();
}
const quote = (value: unknown): string => JSON.stringify(value).replace(/[\u007f-\uffff]/g,
  character => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"));
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${quote(key)}:${canonical(value[key])}`).join(",")}}`;
  return quote(value);
}
const digest = (value: unknown) => createHash("sha256").update(canonical(value) + "\n").digest("hex");
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value) && value !== "00000000-0000-0000-0000-000000000000";

/** Consume canonical bytes produced by the shared Python validator. Requiring
 * exact canonical JSON also rejects duplicate keys and ambiguous encodings.
 */
export function parseStartupLoginConfig(raw: Uint8Array, env: Record<string, string | undefined>): StartupLoginConfig {
  const refuse = () => { throw Error("Startup identity configuration unavailable"); };
  if (raw.byteLength < 1 || raw.byteLength > 16384) return refuse();
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    value = JSON.parse(text);
    if (canonical(value) + "\n" !== text) return refuse();
  } catch { return refuse(); }
  if (!fields(value, ["schema_version", "binding", "binding_sha256", "owner"]) || value.schema_version !== 1 ||
      !fields(value.binding, ["version", "entra", "sea_public_key", "organizations", "platform_admin", "keycloak_admin"]) || value.binding.version !== 1 ||
      !fields(value.owner, ["tenant_id", "network_id", "profile", "broker"]) ||
      !fields(value.owner.profile, ["email"]) || typeof value.owner.profile.email !== "string" ||
      value.owner.profile.email.length > 254 || !/^[^\s@\x00-\x1f\x7f]{1,64}@[^\s@\x00-\x1f\x7f]{1,253}$/.test(value.owner.profile.email) ||
      !fields(value.owner.broker, ["issuer", "audience"]) ||
      !fields(value.binding.entra, ["tenant_id", "object_id", "issuer", "audience", "subject", "broker"]) ||
      !uuid(value.binding.entra.tenant_id) || !uuid(value.binding.entra.object_id) || !uuid(value.binding.entra.audience) ||
      value.binding.entra.issuer !== `https://login.microsoftonline.com/${value.binding.entra.tenant_id}/v2.0` ||
      typeof value.binding.entra.subject !== "string" || !/^[\x21-\x7e]{1,256}$/.test(value.binding.entra.subject) ||
      typeof value.binding.entra.broker !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(value.binding.entra.broker) ||
      !fields(value.binding.platform_admin, ["spanopticon", "hyperme.sh"]) ||
      Object.values(value.binding.platform_admin).some(flag => typeof flag !== "boolean") ||
      !fields(value.binding.keycloak_admin, ["realm", "enabled"]) || typeof value.binding.keycloak_admin.enabled !== "boolean" ||
      typeof value.binding.keycloak_admin.realm !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(value.binding.keycloak_admin.realm) ||
      !fields(value.binding.organizations, ["fyberlabs", "hyperme.sh", "tennesseewindage"]) ||
      value.binding_sha256 !== digest(value.binding)) return refuse();
  const organizations = [];
  for (const slug of Object.keys(value.binding.organizations).sort()) {
    const row = value.binding.organizations[slug];
    if (!fields(row, ["tenant_id", "organization_id", "roles"])) return refuse();
    organizations.push({ slug, id: row.organization_id, tenant_id: row.tenant_id, roles: row.roles });
  }
  const binding = snapshotStartupLoginBinding({ ...value.binding, binding_sha256: value.binding_sha256,
    mapping_sha256: digest(value), tenant_id: value.owner.tenant_id, network_id: value.owner.network_id, organizations });
  if (binding) {
    try {
      const [x, y] = binding.sea_public_key.split(".");
      createPublicKey({ key: { kty: "EC", crv: "P-256", x, y }, format: "jwk" });
    } catch { return refuse(); }
  }
  const provider = findOidcProvider(env, env.S3RCH_STARTUP_LOGIN_PROVIDER);
  if (!binding || !provider || provider.issuer !== value.owner.broker.issuer || provider.clientId !== value.owner.broker.audience ||
      !provider.issuer.startsWith("https://")) return refuse();
  let endpoint: URL;
  try { endpoint = new URL(env.S3RCH_STARTUP_AUTH_URL ?? ""); } catch { return refuse(); }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      !endpoint.pathname.endsWith("/auth/startup/identity")) return refuse();
  return Object.freeze({ binding, provider, alias: value.binding.entra.broker, endpoint: endpoint.href });
}

/** Default off. No file read or network call occurs until explicitly enabled. */
export async function readStartupLoginConfig(env: Record<string, string | undefined> = process.env): Promise<StartupLoginConfig | null> {
  if (env.S3RCH_STARTUP_LOGIN_ENABLED !== "1") return null;
  const path = env.STARTUP_IDENTITY_CONFIG_FILE;
  if (!path || !isAbsolute(path) || !env.S3RCH_STARTUP_LOGIN_PROVIDER) throw Error("Startup identity configuration unavailable");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.geteuid?.() || stat.mode & 0o077 || stat.nlink !== 1 || stat.size > 16384) {
      throw Error("Startup identity configuration unavailable");
    }
    const bytes = Buffer.alloc(16385); let used = 0;
    while (used < bytes.byteLength) {
      const { bytesRead } = await file.read(bytes, used, bytes.byteLength - used, null);
      if (bytesRead === 0) break;
      used += bytesRead;
    }
    return parseStartupLoginConfig(bytes.subarray(0, used), env);
  } finally { await file.close(); }
}
