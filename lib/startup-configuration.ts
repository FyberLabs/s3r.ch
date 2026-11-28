import { releaseColor } from "./crash-report";

type Environment = Record<string, string | undefined>;

const required = [
  "S3RCH_SESSION_SIGNING_KEY", "S3RCH_MEDIA_SIGNING_KEY", "S3RCH_SERVICE_CREDENTIAL",
  "S3RCH_IDENTITY_BLOB_ACCOUNT", "S3RCH_IDENTITY_BLOB_CONTAINER",
];
const statementSource = [
  "S3RCH_STATEMENT_SOURCE_ORIGIN", "S3RCH_STATEMENT_SOURCE_TENANT_ID", "S3RCH_STATEMENT_SOURCE_SCOPE",
];

function present(value: string | undefined) {
  const text = value?.trim() ?? "";
  return text.length > 0 && !text.startsWith("@Microsoft.KeyVault(");
}

/** Return only setting names from this application-owned list. */
export function startupConfiguration(env: Environment) {
  const color = env.S3RCH_RELEASE_COLOR === "staging" ? "staging" : releaseColor(env.S3RCH_RELEASE_COLOR);
  if (!color) return;
  const revision = env.APP_BUILD_REVISION ?? "";
  const missing = required.filter(name => !present(env[name]));
  if (!/^[a-f0-9]{40}$/.test(revision)) missing.push("APP_BUILD_REVISION");

  if (env.S3RCH_STARTUP_LOGIN_ENABLED === "1") {
    for (const name of ["S3RCH_STARTUP_LOGIN_PROVIDER", "S3RCH_STARTUP_AUTH_URL"]) {
      if (!present(env[name])) missing.push(name);
    }
  }
  if (env.S3RCH_AUTHORITY_BACKEND === "acl") {
    missing.push(...statementSource.filter(name => !present(env[name])));
    if (present(env.S3RCH_STATEMENT_SOURCE_KEY_VAULT_URI)) {
      if (!present(env.AZURE_CLIENT_ID)) missing.push("AZURE_CLIENT_ID");
    } else if (!present(env.S3RCH_SERVICE_CREDENTIAL)) {
      missing.push("S3RCH_SERVICE_CREDENTIAL");
    }
  }
  return {
    event: "s3rch.startup.configuration",
    release: color,
    revision: /^[a-f0-9]{40}$/.test(revision) ? revision : null,
    missing: missing.sort((a, b) => a.localeCompare(b)),
  };
}

export function reportStartupConfiguration(env = process.env) {
  const report = startupConfiguration(env);
  if (report) console.info(JSON.stringify(report));
  return Boolean(report);
}