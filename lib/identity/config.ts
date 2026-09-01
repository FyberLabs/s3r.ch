/** Quiet SIWE statement. Do not turn this into recovery or KYC copy. */
export const SIWE_STATEMENT = "Sign in to s3r.ch";

/** Wallet-signed link: this SEA pub belongs to this checksummed address. */
export const MESH_LINK_STATEMENT =
  "s3r.ch binds this Gun SEA pub to this Ethereum address.";

export const NONCE_TTL_SECONDS = 5 * 60;
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const SIWE_MESSAGE_TTL_MS = 10 * 60 * 1000;

export const MIN_SECRET_LENGTH = 32;

/** Used only when IDENTITY_SESSION_SECRET is unset and NODE_ENV is not production. */
export const LOCAL_SESSION_SECRET = "s3rch-local-identity-session-secret";

export const ALLOWED_SIWE_HOSTS = new Set(["s3r.ch", "localhost", "127.0.0.1"]);

export const COOKIE_BASE = {
  nonce: "s3rch-nonce",
  session: "s3rch-session",
} as const;
