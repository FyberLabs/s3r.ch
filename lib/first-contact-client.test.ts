import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { historyState, parsePrincipalId, signWithKeyring, type ResolutionContext } from 'sociacl-ids';
import { firstContactRequestBytes, firstContactDescriptorBytes, firstContactDescriptorFloor } from 'sociacl-ids/first-contact';
import { openFirstContactFloor } from 'sociacl-ids/first-contact-floor';
import { openFirstContactStore } from 'sociacl-ids/first-contact-store';
import { createFirstContactClient } from './first-contact-client';
import fixture from './identity/vectors/first-contact-client.json';

// Fixed public crypto fixture from SociACL vectors/first-contact/v1.json. This is
// a scoped adapter contract with in-memory transport/IDB, not a live service test.
test('installed SociACL sender and recipient compose through configured Spanopticon', async () => {
  const p = parsePrincipalId(fixture.request.sender); if (!p.ok) throw Error(p.reason);
  const owner = p.value, now = fixture.request.issuedAt + 20, indexedDB = new IDBFactory();
  const context: ResolutionContext = { now, jwks: { keys: [] }, links: new Map(), pinnedIss: new Set(),
    policy: { allowedDomains: [], allowedUris: [], allowedChainIds: [], clockSkewSeconds: 0 },
    history: (p, at, until) => ({ ok: true, value: historyState(p, [], at, until) }) };
  const state = () => ({ rotations: [], context });
  const store = await openFirstContactStore({ name: 'consumer', owner, now: () => now, indexedDB, create: true });
  const descriptor = await store.activate({ ...fixture.descriptor, encryptionEpub: fixture.request.replyEpub });
  const key = new Uint8Array(32); key[31] = 1;
  const sign = (bytes: Uint8Array) => { const result = signWithKeyring(key, bytes, owner); if (!result.ok) throw Error(result.reason); return result.value; };
  const advertisement = { v: 1 as const, owner, issuedAt: now, descriptor, sig: '' };
  advertisement.sig = sign(firstContactDescriptorBytes(advertisement));
  const floor = await openFirstContactFloor({ name: 'consumer-floor', owner, anchor: firstContactDescriptorFloor(advertisement), now: () => now, indexedDB, create: true });
  const reply = parsePrincipalId(fixture.request.replyEpub); if (!reply.ok) throw Error(reply.reason);
  const request = { ...fixture.request, v: 1 as const, sender: owner, replyEpub: reply.value,
    channelId: descriptor.channelId, descriptorRevision: descriptor.revision, sig: '' };
  request.sig = sign(firstContactRequestBytes(request));
  const stored = new Map<string, string>(); const writes: Uint8Array[] = []; let loseResponse = true;
  const fetcher = (async (url, init) => {
    assert.equal(url, `https://plane.example/api/v1/acl/sociacl/first-contact/${descriptor.channelId}/messages`);
    assert.equal(init!.credentials, 'omit'); assert.equal(init!.redirect, 'error'); assert.equal(init!.referrerPolicy, 'no-referrer');
    assert.ok(init!.signal);
    if (init!.method === 'POST') {
      const bytes = new Uint8Array(init!.body as Uint8Array), id = createHash('sha256').update(bytes).digest('hex');
      writes.push(bytes); stored.set(id, Buffer.from(bytes).toString('base64'));
      if (loseResponse) { loseResponse = false; throw Error('lost reply'); }
      return Response.json({ id });
    }
    return Response.json({ messages: [...stored].map(([id, ciphertext]) => ({ id, ciphertext })) });
  }) as typeof fetch;
  const client = createFirstContactClient('https://plane.example', fetcher);
  try {
    await assert.rejects(client.prepare(request, { ...advertisement, sig: 'A'.repeat(86) }, owner, floor, state, state));
    assert.equal(writes.length, 0);
    const prepared = await client.prepare(request, advertisement, owner, floor, state, state);
    await assert.rejects(prepared.submit(), /lost reply/);
    assert.equal(await prepared.submit(), prepared.ciphertextId);
    assert.deepEqual(writes[0], writes[1]); assert.equal(stored.size, 1);
    const epriv = Buffer.alloc(32); epriv[31] = 2;
    const [received] = await client.poll(store, epriv.toString('base64url'), state);
    assert.equal(received.request.message, request.message);
    assert.equal((await client.poll(store, epriv.toString('base64url'), state)).length, 0);
    assert.equal((await store.outbox()).length, 0); // Receiving never accepts.
    assert.equal((await store.pending()).length, 1);
  } finally { floor.close(); store.close(); }
});

test('transport abort propagates from the consumer deadline', async () => {
  const { createFirstContactTransport } = await import('./contact-lane-transport');
  const abort = new AbortController(); let signal: AbortSignal | undefined;
  const transport = createFirstContactTransport('https://plane.example', (async (_url, init) => {
    signal = init!.signal as AbortSignal;
    return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(Error('cancelled')), { once: true }));
  }) as typeof fetch);
  const pending = transport.read('ab'.repeat(32), abort.signal);
  abort.abort(); await assert.rejects(pending, /cancelled/); assert.equal(signal?.aborted, true);
});
