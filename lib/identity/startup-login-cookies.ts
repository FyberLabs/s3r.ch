export const startupPendingName = (secure: boolean) => `${secure ? "__Host-" : ""}s3rch-startup-pkce`;
export const startupCredentialName = (secure: boolean) => `${secure ? "__Host-" : ""}s3rch-startup-credential`;
export const startupCookieNames = () => [startupPendingName(true), startupPendingName(false), startupCredentialName(true), startupCredentialName(false)];
