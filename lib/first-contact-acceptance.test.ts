import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { historyState, parsePrincipalId, signWithKeyring, type ResolutionContext } from 'sociacl-ids';
import { sealFirstContactRequest, firstContactRequestBytes } from 'sociacl-ids/first-contact';
import { deriveContactLane, openContactLaneGrant } from 'sociacl-ids/contact-lane';
import { openFirstContactStore } from 'sociacl-ids/first-contact-store';
import { createFirstContactClient } from './first-contact-client';
import fixture from './identity/vectors/contact-acceptance.json';

// Public synthetic vectors from SociACL 8d75c494, never hosted identities.
// Exercise the shipped browser API through the production consumer/transport.
async function setup() {
  const sender = fixture.genesis, owner = fixture.mint, indexedDB = new IDBFactory();
  const parsed = parsePrincipalId(sender.signingPub); if (!parsed.ok) throw Error(parsed.reason);
  const known = new Set([sender.signingPub, owner.signingPub]);
  const context: ResolutionContext = { ...fixture.context,
    jwks: fixture.context.jwks as ResolutionContext['jwks'],
    links: new Map(fixture.context.links as []), pinnedIss: new Set(fixture.context.pinnedIss),
    genesisEpubBindings: [fixture.genesisBinding],
    history: (p, at, until) => known.has(p) ? { ok: true, value: historyState(p, [], at, until) } : { ok: false, reason: 'missing-history' },
  };
  const state = () => ({ rotations: [], context });
  let unlocked = true;
  const issuer = () => {
    if (!unlocked) throw Error('Locked');
    return { ...state(), issuer: { principal: owner.signingPub, signingPriv: owner.signingPriv,
      contactSecretHex: owner.contactLaneSecret, rotationSeq: 0,
      baseLaneIds: [owner.laneId], contactSecrets: [owner.contactLaneSecret] } };
  };
  const options = { name: 'acceptance', owner: owner.signingPub, now: () => context.now, indexedDB };
  const store = await openFirstContactStore({ ...options, create: true });
  const descriptor = await store.activate({ encryptionEpub: owner.epub, expiresAt: context.now + 600,
    maxLifetimeSeconds: 300, maxMessageBytes: 1024 });
  const reply = parsePrincipalId(sender.epub); if (!reply.ok) throw Error(reply.reason);
  const request = { v: 1 as const, channelId: descriptor.channelId, descriptorRevision: descriptor.revision,
    sender: parsed.value, replyEpub: reply.value, nonce: 'ab'.repeat(32), issuedAt: context.now,
    expiresAt: context.now + 300, message: 'Public synthetic contact request' };
  const sig = signWithKeyring(Buffer.from(sender.signingPriv, 'base64url'), firstContactRequestBytes(request), parsed.value);
  if (!sig.ok) throw Error(sig.reason);
  const ciphertext = await sealFirstContactRequest({ ...request, sig: sig.value }, descriptor);
  let writes = 0;
  const client = createFirstContactClient('https://plane.example', (async (_url, init) => {
    if (init?.method !== 'GET') { writes++; throw Error('Unexpected grant delivery'); }
    return Response.json({ messages: [{ id: createHash('sha256').update(ciphertext).digest('hex'),
      ciphertext: Buffer.from(ciphertext).toString('base64') }] });
  }) as typeof fetch);
  const [pending] = await client.poll(store, owner.epriv, state);
  assert.ok(pending); assert.equal((await store.outbox()).length, 0);
  return { sender, owner, store, options, state, issuer, client, pending,
    lock: () => { unlocked = false; }, writes: () => writes };
}

test('explicit acceptance uses the real grant codec and retains committed ciphertext after restart', async () => {
  const f = await setup();
  try {
    const grant = await f.client.accept(f.store, f.pending.replayKey, f.pending.requestId, f.owner.epriv, f.state, f.issuer);
    const opened = await openContactLaneGrant(f.sender.signingPub, f.sender.epriv, grant, f.owner.signingPub, f.state);
    assert.equal(opened.laneId, deriveContactLane(f.owner.contactLaneSecret, f.owner.signingPub, f.sender.signingPub));
    assert.equal(f.writes(), 0); // Acceptance is not delivery or acknowledgement.
    await assert.rejects(f.client.accept(f.store, f.pending.replayKey, f.pending.requestId, f.owner.epriv, f.state, f.issuer));
    f.store.close();
    const restored = await openFirstContactStore(f.options);
    try {
      const rows = await restored.outbox();
      assert.equal(rows.length, 1); assert.equal(rows[0].grant?.ciphertextHex, grant.ciphertextHex);
      assert.deepEqual(await f.client.restorePending(restored, f.owner.epriv, f.state), []);
    } finally { restored.close(); }
  } finally { f.store.close(); }
});

test('wrong displayed request and locked keyring cannot issue a grant', async () => {
  const f = await setup();
  try {
    await assert.rejects(f.client.accept(f.store, f.pending.replayKey, '00'.repeat(32), f.owner.epriv, f.state, f.issuer));
    assert.equal((await f.store.outbox()).length, 0);
    f.lock();
    await assert.rejects(f.client.accept(f.store, f.pending.replayKey, f.pending.requestId, f.owner.epriv, f.state, f.issuer), /Locked/);
    assert.equal((await f.store.outbox()).length, 0); assert.equal((await f.store.pending()).length, 1);
    assert.equal(f.writes(), 0);
  } finally { f.store.close(); }
});
