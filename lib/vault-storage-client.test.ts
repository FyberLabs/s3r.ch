import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { parsePrincipalId, signWithKeyring, historyState, type ResolutionContext } from 'sociacl-ids';
import { vaultSyncHeadSigningBytes, vaultSyncHeadFloor, openVaultSyncHeadStore, type VaultSyncHead } from 'sociacl-ids/vault-sync';
import { createVaultStorageClient } from './vault-storage-client';
import { createSpanopticonVaultTransport } from './vault-storage-transport-server';
import fixture from './identity/vectors/first-contact-client.json';
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const principal = parsePrincipalId(fixture.request.sender); if (!principal.ok) throw Error(principal.reason);
const owner = principal.value, vaultId = 'ab'.repeat(32), key = new Uint8Array(32); key[31] = 1;
const keybag = encode('fixture-keybag'), index = encode('fixture-index');
const context: ResolutionContext = { now: 20, jwks: { keys: [] }, links: new Map(), pinnedIss: new Set(),
  policy: { allowedDomains: [], allowedUris: [], allowedChainIds: [], clockSkewSeconds: 0 },
  history: (p, at, until) => ({ ok: true, value: historyState(p, [], at, until) }) };
function signed(change: Partial<VaultSyncHead> = {}): VaultSyncHead {
  const r: VaultSyncHead = { v: 1, owner, vaultId, revision: 1, previousDigest: '00'.repeat(32), keybagDigest: hash(keybag),
    indexDigest: hash(index), minimumProfile: 1, issuedAt: 10, sig: 'A'.repeat(86), ...change };
  const result = signWithKeyring(key, vaultSyncHeadSigningBytes(r), owner); if (!result.ok) throw Error(result.reason);
  return { ...r, sig: result.value };
}
async function setup() {
  const root = signed(), indexedDB = new IDBFactory();
  const options = { name: 'vault-client', owner, vaultId, anchor: vaultSyncHeadFloor(root), now: () => 20, indexedDB };
  const floor = await openVaultSyncHeadStore({ ...options, create: true });
  const rows = new Map<string, { bytes: Uint8Array; revision: string }>();
  let calls = 0, writes = 0, loseResponse = false, corrupt = false;
  const fetcher = (async (url, init) => {
    calls++; assert.equal(init!.credentials, 'omit'); assert.equal(init!.redirect, 'error');
    const path = new URL(String(url)).pathname;
    assert.ok(path.startsWith('/api/v1/storage/objects/') || path === '/api/v1/storage/records/vault/' + vaultId);
    const object = path.includes('/objects/'), existing = rows.get(path), headers = new Headers(init!.headers);
    if (init!.method === 'PUT') {
      const bytes = new Uint8Array(init!.body as Uint8Array);
      if (!object && (existing ? headers.get('If-Match') !== '"' + existing.revision + '"' : headers.get('If-None-Match') !== '*')) return new Response(null, { status: 412 });
      const revision = object ? hash(bytes) : (++writes).toString(16).padStart(64, '0'); rows.set(path, { bytes, revision });
      if (!object && loseResponse) { loseResponse = false; throw Error('response lost'); }
      return new Response(null, { status: existing ? 204 : 201, headers: { ETag: '"' + revision + '"' } });
    }
    if (!existing) return new Response(null, { status: 404 });
    const bytes = new Uint8Array(existing.bytes); if (corrupt && object) bytes[0] ^= 1;
    return new Response(bytes, { headers: { ETag: '"' + existing.revision + '"', 'Content-Length': String(bytes.length) } });
  }) as typeof fetch;
  const transport = createSpanopticonVaultTransport({ origin: 'https://plane.example', tenant: '12345678-1234-1234-1234-123456789abc', apiKey: 'fixture-service-key' }, fetcher);
  // Unit custody double only. Production decrypts and authenticates locally.
  const client = createVaultStorageClient({ owner, vaultId, transport, floor, current: () => ({ rotations: [], context }), openHead: async bytes => JSON.parse(new TextDecoder().decode(bytes)) });
  return { root, floor, client, options, calls: () => calls, writes: () => writes, lose: () => { loseResponse = true; }, corrupt: () => { corrupt = true; } };
}
test('vault consumer reconciles Spanopticon response loss and retains its head across reopen', async () => {
  const s = await setup();
  try {
    s.lose(); const first = await s.client.publish({ encryptedHead: encode(s.root), keybag, index, previous: null, expectedStorageRevision: null });
    await s.client.publish({ encryptedHead: encode(s.root), keybag, index, previous: null, expectedStorageRevision: null }); assert.equal(s.writes(), 1);
    const next = signed({ revision: 2, previousDigest: vaultSyncHeadFloor(s.root).digest, issuedAt: 11, minimumProfile: 2 });
    await s.client.publish({ encryptedHead: encode(next), keybag, index, previous: s.root, expectedStorageRevision: first.storageRevision });
    assert.deepEqual((await s.client.readCurrent()).head, next); s.floor.close();
    const reopened = await openVaultSyncHeadStore(s.options);
    assert.deepEqual(await reopened.verifyCurrent(next, () => ({ rotations: [], context })), next); reopened.close();
  } finally { s.floor.close(); }
});
test('forged heads never reach transport; conflicts and corrupt readback never advance the floor', async () => {
  const s = await setup();
  try {
    await assert.rejects(s.client.publish({ encryptedHead: encode({ ...s.root, sig: 'A'.repeat(86) }), keybag, index, previous: null, expectedStorageRevision: null }));
    await assert.rejects(s.client.publish({ encryptedHead: encode(s.root), keybag: encode('wrong'), index, previous: null, expectedStorageRevision: null })); assert.equal(s.calls(), 0);
    const first = await s.client.publish({ encryptedHead: encode(s.root), keybag, index, previous: null, expectedStorageRevision: null });
    const next = signed({ revision: 2, previousDigest: vaultSyncHeadFloor(s.root).digest, issuedAt: 11 });
    await assert.rejects(s.client.publish({ encryptedHead: encode(next), keybag, index, previous: s.root, expectedStorageRevision: 'ff'.repeat(32) }));
    assert.deepEqual(await s.floor.read(), vaultSyncHeadFloor(s.root)); s.corrupt();
    await assert.rejects(s.client.publish({ encryptedHead: encode(next), keybag, index, previous: s.root, expectedStorageRevision: first.storageRevision }));
    assert.deepEqual(await s.floor.read(), vaultSyncHeadFloor(s.root));
  } finally { s.floor.close(); }
});
