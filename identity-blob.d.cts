export const IDENTITY_BLOB_NAME: string;
export const IDENTITY_BLOB_MAX_BYTES: number;
export const EMPTY_DOCUMENT: string;

export type BlobConfig = { account: string; container: string; url: string };

export type IdentityBlobDownload =
  | { found: false }
  | { found: true; text: string; etag: string };

export type IdentityBlobConditions = { ifMatch?: string; ifNoneMatch?: "*" };

export type IdentityBlobClient = {
  assertReachable(): void;
  download(blobName: string): IdentityBlobDownload;
  upload(blobName: string, text: string, conditions: IdentityBlobConditions): { etag: string };
};

export function readBlobConfig(env?: NodeJS.ProcessEnv): BlobConfig;
export function blobServiceUrl(account: string): string;
export function blobConflict(): Error & { code: "blob-conflict" };
export function createBlockingWorker(
  workerPath: string,
  initMessage: Record<string, unknown>,
  timeoutMs?: number,
): {
  call(message: Record<string, unknown>): { ok?: boolean; code?: string; echo?: number; etag?: string; text?: string };
  terminate(): Promise<number>;
};
export function interpretBlobReply(message: { ok?: boolean; code?: string; reason?: string; etag?: string; text?: string }): {
  ok?: boolean;
  etag?: string;
  text?: string;
};
export function createProductionBlobClient(config: BlobConfig): IdentityBlobClient;
export function assertBlobReady(config: BlobConfig, client: IdentityBlobClient): void;
