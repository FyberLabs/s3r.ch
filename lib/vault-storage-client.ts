/** Client-side encrypted-head publication. Transport never receives private keys. */
import { verifyVaultSyncHead, vaultSyncHeadFloor, type VaultSyncHead, type VaultHeadIdentityState,
  type openVaultSyncHeadStore } from 'sociacl-ids/vault-sync';
import type { PrincipalId } from 'sociacl-ids';
export type VaultHeadTransport = Readonly<{
  read(id: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; revision: string } | null>;
  write(id: string, bytes: Uint8Array, expected: string | null, signal?: AbortSignal): Promise<string>;
  putObject(id: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
  getObject(id: string, signal?: AbortSignal): Promise<Uint8Array | null>;
}>;
const MAX = 8 * 1024 * 1024;
const hex = (b: Uint8Array) => Array.from(b, v => v.toString(16).padStart(2, '0')).join('');
async function digest(b: Uint8Array) { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(b)))); }
function snapshot(b: Uint8Array): Uint8Array {
  if (!(b instanceof Uint8Array) || !b.length || b.length > MAX) throw Error('Invalid encrypted vault bytes');
  return new Uint8Array(b);
}
function revision(s: string) { if (!/^[a-f0-9]{64}$/.test(s)) throw Error('Invalid storage revision'); return s; }
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/** openHead is the trusted local custody adapter. It authenticates/decrypts a
 * private signed head; keys stay there. The transport is an authenticated proxy
 * for the fixed shared storage space, never a URL selected by stored metadata. */
export function createVaultStorageClient(input: {
  owner: PrincipalId; vaultId: string; transport: VaultHeadTransport;
  floor: Awaited<ReturnType<typeof openVaultSyncHeadStore>>;
  current: VaultHeadIdentityState; openHead(bytes: Uint8Array): Promise<unknown>;
}) {
  const { owner, vaultId, transport, floor, current, openHead } = input;
  if (!/^[a-f0-9]{64}$/.test(vaultId)) throw Error('Invalid vault identifier');
  function operation(signal?: AbortSignal) {
    const deadline = AbortSignal.timeout(120_000);
    const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let last = -1;
    function state() {
      abort.throwIfAborted(); const value = current();
      if (!Number.isSafeInteger(value.context.now) || value.context.now < last) throw Error('Vault clock rollback');
      last = value.context.now; return value;
    }
    function verify(raw: unknown) {
      const s = state(); return verifyVaultSyncHead(raw, owner, vaultId, s.rotations, s.context);
    }
    return { abort, state, verify };
  }
  return Object.freeze({
    async readCurrent(signal?: AbortSignal) {
      const op = operation(signal); op.state();
      const row = await transport.read(vaultId, op.abort); op.state();
      if (!row) throw Error('Missing vault head');
      const bytes = snapshot(row.bytes), tag = revision(row.revision);
      const head = op.verify(await openHead(new Uint8Array(bytes)));
      await floor.verifyCurrent(head, op.state); op.verify(head);
      return Object.freeze({ head, bytes, storageRevision: tag });
    },
    /** Prepare encrypted bytes once and retain them through ambiguous results.
     * previous=null is explicit bootstrap against an already trusted local floor.
     * Conflicts refuse: callers keep their candidate and resolve all parents. */
    async publish(prepared: { encryptedHead: Uint8Array; keybag: Uint8Array; index: Uint8Array;
      previous: VaultSyncHead | null; expectedStorageRevision: string | null }, signal?: AbortSignal) {
      const op = operation(signal);
      const bytes = snapshot(prepared.encryptedHead), keybag = snapshot(prepared.keybag), index = snapshot(prepared.index);
      const previous = prepared.previous === null ? null : structuredClone(prepared.previous);
      const expected = prepared.expectedStorageRevision === null ? null : revision(prepared.expectedStorageRevision);
      op.state();
      const head = op.verify(await openHead(new Uint8Array(bytes))), next = vaultSyncHeadFloor(head);
      if (await digest(keybag) !== head.keybagDigest || await digest(index) !== head.indexDigest) throw Error('Vault object digest mismatch');
      if (previous) {
        const before = vaultSyncHeadFloor(previous);
        if (previous.owner !== owner || previous.vaultId !== vaultId || head.revision !== previous.revision + 1 ||
          head.previousDigest !== before.digest || head.minimumProfile < previous.minimumProfile || head.issuedAt < previous.issuedAt || expected === null)
          throw Error('Invalid vault successor');
        const saved = await floor.read();
        if (!(saved.revision === before.revision && saved.digest === before.digest) &&
          !(saved.revision === next.revision && saved.digest === next.digest)) throw Error('Vault continuity conflict');
      } else {
        if (head.revision !== 1 || expected !== null) throw Error('Explicit initial vault head required');
        await floor.verifyCurrent(head, op.state);
      }
      op.verify(head);
      await transport.putObject(head.keybagDigest, new Uint8Array(keybag), op.abort);
      op.verify(head);
      await transport.putObject(head.indexDigest, new Uint8Array(index), op.abort);
      op.verify(head);
      let row = await transport.read(vaultId, op.abort); op.verify(head);
      if (!row || !same(snapshot(row.bytes), bytes)) {
        if ((row ? revision(row.revision) : null) !== expected) throw Error('Vault storage conflict');
        try { await transport.write(vaultId, new Uint8Array(bytes), expected, op.abort); }
        catch { op.verify(head); /* Ambiguous result: exact readback below decides. */ }
        row = await transport.read(vaultId, op.abort); op.verify(head);
      }
      if (!row || !same(snapshot(row.bytes), bytes)) throw Error('Vault publication not confirmed');
      const tag = revision(row.revision);
      for (const id of [head.keybagDigest, head.indexDigest]) {
        const stored = await transport.getObject(id, op.abort); op.verify(head);
        if (!stored || await digest(snapshot(stored)) !== id) throw Error('Missing or altered vault object');
      }
      op.verify(head);
      if (previous) await floor.advance(previous, head, op.state);
      else await floor.verifyCurrent(head, op.state);
      op.verify(head);
      return Object.freeze({ head, storageRevision: tag });
    },
  });
}
