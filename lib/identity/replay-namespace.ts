import { createHash } from "node:crypto";

/** Stable issuer namespace shared by legacy route aliases and site identity. */
export const identitySessionNamespace = (origin: string) => createHash("sha256").update(JSON.stringify(["s3rch-identity-session-v1", origin])).digest("hex");
