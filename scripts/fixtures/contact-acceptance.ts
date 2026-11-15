// Public synthetic identities; real browser crypto, IndexedDB and consumer.
import { historyState, parsePrincipalId, signWithKeyring, type ResolutionContext } from 'sociacl-ids';
import { firstContactRequestBytes, sealFirstContactRequest } from 'sociacl-ids/first-contact';
import { deriveContactLane, openContactLaneGrant } from 'sociacl-ids/contact-lane';
import { openFirstContactStore } from 'sociacl-ids/first-contact-store';
import { createFirstContactClient } from '../../lib/first-contact-client';
import fixture from '../../lib/identity/vectors/contact-acceptance.json';

export async function contactAcceptance() {
  const sender = fixture.genesis, owner = fixture.mint;
  const context: ResolutionContext = { ...fixture.context,
    jwks: fixture.context.jwks as ResolutionContext['jwks'],
    links: new Map(fixture.context.links as []), pinnedIss: new Set(fixture.context.pinnedIss),
    genesisEpubBindings: [fixture.genesisBinding],
    history: (p, at, until) => [sender.signingPub, owner.signingPub].includes(p)
      ? { ok: true, value: historyState(p, [], at, until) } : { ok: false, reason: 'missing-history' } };
  const state = () => ({ rotations: [], context });
  const issuer = () => ({ ...state(), issuer: { principal: owner.signingPub, signingPriv: owner.signingPriv,
    contactSecretHex: owner.contactLaneSecret, rotationSeq: 0,
    baseLaneIds: [owner.laneId], contactSecrets: [owner.contactLaneSecret] } });
  const options = { name: 'consumer-acceptance', owner: owner.signingPub, now: () => context.now };
  const store = await openFirstContactStore({ ...options, create: true });
  try {
    const descriptor = await store.activate({ encryptionEpub: owner.epub, expiresAt: context.now + 600,
      maxLifetimeSeconds: 300, maxMessageBytes: 1024 });
    const principal = parsePrincipalId(sender.signingPub), reply = parsePrincipalId(sender.epub);
    if (!principal.ok || !reply.ok) throw Error('Fixture identity');
    const request = { v: 1 as const, channelId: descriptor.channelId, descriptorRevision: descriptor.revision,
      sender: principal.value, replyEpub: reply.value, nonce: 'ab'.repeat(32), issuedAt: context.now,
      expiresAt: context.now + 300, message: 'Public synthetic contact request' };
    const scalar = Uint8Array.from(atob(sender.signingPriv.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const sig = signWithKeyring(scalar, firstContactRequestBytes(request), principal.value); scalar.fill(0);
    if (!sig.ok) throw Error('Fixture signature');
    const ciphertext = await sealFirstContactRequest({ ...request, sig: sig.value }, descriptor);
    const id = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(ciphertext))), b => b.toString(16).padStart(2, '0')).join('');
    const client = createFirstContactClient('https://plane.example', (async (_url, init) => {
      if (init?.method !== 'GET') throw Error('Unexpected delivery');
      return Response.json({ messages: [{ id, ciphertext: btoa(String.fromCharCode(...ciphertext)) }] });
    }) as typeof fetch);
    const [pending] = await client.poll(store, owner.epriv, state);
    if (!pending || (await store.outbox()).length) throw Error('Receive accepted');
    const grant = await client.accept(store, pending.replayKey, pending.requestId, owner.epriv, state, issuer);
    const opened = await openContactLaneGrant(sender.signingPub, sender.epriv, grant, owner.signingPub, state);
    if (opened.laneId !== deriveContactLane(owner.contactLaneSecret, owner.signingPub, sender.signingPub)) throw Error('Wrong lane');
    store.close();
    const restored = await openFirstContactStore(options);
    try {
      const rows = await restored.outbox();
      if (rows.length !== 1 || rows[0].grant?.ciphertextHex !== grant.ciphertextHex) throw Error('Lost committed grant');
    } finally { restored.close(); }
  } finally { store.close(); }
}
Object.assign(window, { contactAcceptance });
