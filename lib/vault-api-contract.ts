/** Public operation metadata only; encrypted head contents never enter this envelope. */
export const VAULT_API_LIMIT = 12 * 1024 * 1024;
export type VaultOperation = { v: 1; origin: string; owner: string; vaultId: string;
  action: 'read' | 'write' | 'getObject' | 'putObject'; id: string;
  digest: string | null; expected: string | null; issuedAt: number; expiresAt: number };
export function vaultOperationBytes(op: VaultOperation): Uint8Array {
  if (!op || Object.keys(op).sort().join() !== 'action,digest,expected,expiresAt,id,issuedAt,origin,owner,v,vaultId' || op.v !== 1 ||
      !['read','write','getObject','putObject'].includes(op.action) || typeof op.owner !== 'string' || op.owner.length > 1024 ||
      !/^[a-f0-9]{64}$/.test(op.vaultId) || !/^[a-f0-9]{64}$/.test(op.id) ||
      !Number.isSafeInteger(op.issuedAt) || op.issuedAt < 0 || !Number.isSafeInteger(op.expiresAt) ||
      op.expiresAt <= op.issuedAt || op.expiresAt - op.issuedAt > 60 ||
      (op.expected !== null && !/^[a-f0-9]{64}$/.test(op.expected))) throw Error('Invalid vault operation');
  const origin = new URL(op.origin);
  if (origin.origin !== op.origin || origin.protocol !== 'https:') throw Error('Invalid vault origin');
  const write = op.action === 'write' || op.action === 'putObject';
  if (write ? typeof op.digest !== 'string' || !/^[a-f0-9]{64}$/.test(op.digest) : op.digest !== null) throw Error('Invalid vault digest');
  if ((op.action === 'read' || op.action === 'write') && op.id !== op.vaultId) throw Error('Invalid vault address');
  if (op.action !== 'write' && op.expected !== null) throw Error('Invalid vault condition');
  if (op.action === 'putObject' && op.digest !== op.id) throw Error('Invalid object digest');
  return new TextEncoder().encode(JSON.stringify(['s3rch-vault-operation-v1',op.origin,op.owner,op.vaultId,op.action,op.id,op.digest,op.expected,op.issuedAt,op.expiresAt]));
}
