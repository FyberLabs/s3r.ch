import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { createContactLaneTransport } from './contact-lane-transport';
const lane = 'ab'.repeat(32), bytes = new Uint8Array(32).fill(42);
const id = createHash('sha256').update(bytes).digest('hex');
const encoded = Buffer.from(bytes).toString('base64');

test('Spanopticon ciphertext roundtrip omits identity and refuses redirects', async () => {
  const calls: RequestInit[] = [];
  const fetcher = (async (url, init) => {
    assert.equal(url, `https://plane.example/api/v1/acl/sociacl/contact-lanes/${lane}/messages`);
    calls.push(init!);
    return Response.json(init!.method === 'POST' ? { id } : { messages: [{ id, ciphertext: encoded }] });
  }) as typeof fetch;
  const transport = createContactLaneTransport('https://plane.example', fetcher);
  assert.equal(await transport.append(lane, bytes), id);
  assert.deepEqual((await transport.read(lane))[0].ciphertext, bytes);
  for (const call of calls) {
    assert.equal(call.credentials, 'omit'); assert.equal(call.redirect, 'error');
    assert.equal(call.referrerPolicy, 'no-referrer'); assert.equal(call.cache, 'no-store');
    const headers = new Headers(call.headers);
    for (const key of ['authorization', 'cookie', 'x-tenant-id', 'x-api-key']) assert.equal(headers.has(key), false);
  }
});

test('invalid routing and payload never reach the network', async () => {
  for (const url of ['http://plane.example', 'https://user:pass@plane.example', 'https://plane.example/api', 'https://plane.example/?q=1']) {
    assert.throws(() => createContactLaneTransport(url));
  }
  const transport = createContactLaneTransport('https://plane.example', (() => { throw Error('network reached'); }) as typeof fetch);
  await assert.rejects(transport.append('~principal', bytes), /lane ID/);
  await assert.rejects(transport.append(lane + '\n', bytes), /lane ID/);
  await assert.rejects(transport.append(lane, new Uint8Array(65537)), /size/);
});

test('corrupt, duplicate, oversized and unavailable responses fail closed', async () => {
  for (const body of [{ messages: [{ id: 'cd'.repeat(32), ciphertext: encoded }] },
    { messages: [{ id, ciphertext: encoded }, { id, ciphertext: encoded }] },
    { messages: Array(129).fill({ id, ciphertext: encoded }) }, { messages: [{ id, ciphertext: '*' }] }]) {
    const transport = createContactLaneTransport('https://plane.example', (async () => Response.json(body)) as typeof fetch);
    await assert.rejects(transport.read(lane));
  }
  const unavailable = createContactLaneTransport('https://plane.example', (async () => new Response('', { status: 503 })) as typeof fetch);
  await assert.rejects(unavailable.read(lane), /503/);
  const huge = createContactLaneTransport('https://plane.example', (async () => new Response('x'.repeat(1500001))) as typeof fetch);
  await assert.rejects(huge.read(lane), /too large/);
});
