import { constants } from "node:fs";
import { open } from "node:fs/promises";

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const fields = (value, keys) => object(value) && Object.keys(value).sort().join() === keys.sort().join();
const uuid = value => typeof value === "string" && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value) && value !== "00000000-0000-0000-0000-000000000000";
const hash = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
function origin(value) { const url = new URL(value); return url.protocol === "https:" && url.origin === value; }
const text = value => typeof value === "string" && value.length > 0 && value.length <= 2048;
export function scheduledStartupBrowser(env) {
  return env.GITHUB_ACTIONS === "true" && env.GITHUB_EVENT_NAME === "schedule" &&
    env.GITHUB_WORKFLOW_REF === "FyberLabs/infra/.github/workflows/nightly-integration.yml@refs/heads/main" &&
    env.NIGHTLY_SUITE === "startup-linked-browser" &&
    env.GITHUB_REPOSITORY === "FyberLabs/s3r.ch" && env.GITHUB_REF === "refs/heads/master";
}

/** Browser-only secret projection. Never accepts the owner orchestration bundle. */
export function validateStartupBrowserFixture(value) {
  const refuse = () => { throw Error("Startup browser fixture unavailable"); };
  try {
    if (!fields(value, ["version", "site_origin", "sea_record", "expected", "negative_organization_id", "login"]) ||
        value.version !== 1 || !origin(value.site_origin) || !uuid(value.negative_organization_id) ||
        !fields(value.sea_record, ["address", "seaPub", "seaPair", "walletSignature", "signedPayload"]) ||
        !/^0x[0-9a-fA-F]{40}$/.test(value.sea_record.address) ||
        !fields(value.sea_record.seaPair, ["pub", "priv", "epub", "epriv"]) ||
        !Object.values(value.sea_record.seaPair).every(text) || value.sea_record.seaPair.pub !== value.sea_record.seaPub ||
        !/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(value.sea_record.seaPub) ||
        !text(value.sea_record.walletSignature) || !text(value.sea_record.signedPayload) ||
        !fields(value.expected, ["sea_public_key", "person_id", "tenant_id", "organization_ids", "binding_sha256", "mapping_sha256"]) ||
        value.expected.sea_public_key !== value.sea_record.seaPub || !uuid(value.expected.person_id) || !uuid(value.expected.tenant_id) ||
        !hash(value.expected.binding_sha256) || !hash(value.expected.mapping_sha256) ||
        !Array.isArray(value.expected.organization_ids) || value.expected.organization_ids.length !== 3 ||
        !value.expected.organization_ids.every(uuid) || new Set(value.expected.organization_ids).size !== 3 ||
        value.expected.organization_ids.includes(value.negative_organization_id) ||
        !fields(value.login, ["driver", "origins", "credentials", "steps"]) || value.login.driver !== "form-v1" ||
        !Array.isArray(value.login.origins) || value.login.origins.length < 1 || value.login.origins.length > 4 ||
        !value.login.origins.every(entry => origin(entry) && entry !== value.site_origin) ||
        !object(value.login.credentials) || !Object.keys(value.login.credentials).length ||
        Object.keys(value.login.credentials).some(key => !["username", "password", "otp"].includes(key)) ||
        !Object.values(value.login.credentials).every(text) || !Array.isArray(value.login.steps) ||
        value.login.steps.length < 1 || value.login.steps.length > 12) return refuse();
    for (const step of value.login.steps) {
      if (!fields(step, step?.action === "fill" ? ["action", "origin", "selector", "credential"] : ["action", "origin", "selector"]) ||
          !["fill", "click"].includes(step.action) || !value.login.origins.includes(step.origin) ||
          typeof step.selector !== "string" || step.selector.length < 1 || step.selector.length > 256 ||
          (step.action === "fill" && !Object.hasOwn(value.login.credentials, step.credential))) return refuse();
    }
    return structuredClone(value);
  } catch { return refuse(); }
}

export async function loadStartupBrowserFixture(path) {
  if (typeof path !== "string" || !path.startsWith("/")) throw Error("Startup browser fixture unavailable");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.geteuid() || stat.mode & 0o077 || stat.nlink !== 1 || stat.size > 65536) throw Error("Startup browser fixture unavailable");
    const bytes = Buffer.alloc(65537); let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await file.read(bytes, used, bytes.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (!used || used > 65536) throw Error("Startup browser fixture unavailable");
    return validateStartupBrowserFixture(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used))));
  } finally { await file.close(); }
}
