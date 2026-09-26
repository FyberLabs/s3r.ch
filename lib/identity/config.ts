/** Quiet SIWE statement. Do not turn this into recovery or KYC copy. */
export const SIWE_STATEMENT = "Sign in to s3r.ch";

/** Wallet-signed link: this SEA pub belongs to this checksummed address. */
export const MESH_LINK_STATEMENT =
  "s3r.ch binds this Gun SEA pub to this Ethereum address.";

/** Wallet-signed secondary wrap: this device DEK wrap is bound to the address. */
export const SECONDARY_WRAP_STATEMENT =
  "s3r.ch secondary wrap of this device mesh key.";

export const NONCE_TTL_SECONDS = 5 * 60;
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const SIWE_MESSAGE_TTL_MS = 10 * 60 * 1000;
/** Short-lived confirm challenge. Not a session. */
export const CONFIRM_TTL_SECONDS = 10 * 60;
/** Lab/dev fixture code. Never a live vendor OTP. */
export const FIXTURE_CONFIRM_CODE = "000000";

export const MIN_SECRET_LENGTH = 32;

/** Used only when IDENTITY_SESSION_SECRET is unset and NODE_ENV is not production. */
export const LOCAL_SESSION_SECRET = "s3rch-local-identity-session-secret";

export const ALLOWED_SIWE_HOSTS = new Set(["s3r.ch", "localhost", "127.0.0.1"]);

/** Short-lived PKCE state. Not a session. */
export const OAUTH_PKCE_TTL_SECONDS = 10 * 60;

/** Public Keycloak client on the controlplane realm. No secret. */
export const OAUTH_CLIENT_ID = "s3rch-web";

export const OAUTH_CALLBACK_PATH = "/api/identity/oauth/callback";

/**
 * Exact redirect URIs registered on `s3rch-web`.
 * Keep in sync with panopticon `infra/keycloak/s3rch_web.py`.
 */
export const OAUTH_REDIRECT_URIS = [
  `https://s3r.ch${OAUTH_CALLBACK_PATH}`,
  `https://www.s3r.ch${OAUTH_CALLBACK_PATH}`,
  `http://localhost:3000${OAUTH_CALLBACK_PATH}`,
  `http://127.0.0.1:3000${OAUTH_CALLBACK_PATH}`,
] as const;

export const COOKIE_BASE = {
  nonce: "s3rch-nonce",
  session: "s3rch-session",
  confirm: "s3rch-confirm",
  oauth: "s3rch-oauth",
  oauthPkce: "s3rch-oauth-pkce",
} as const;
