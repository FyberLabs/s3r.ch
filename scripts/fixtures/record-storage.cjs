// Scheduled isolated fixture only: no outbound network, Azure or tenant secrets.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const file = path.join(process.cwd(), 'tenant-record.json');
const etag = bytes => '"' + createHash('sha256').update(bytes).digest('hex') + '"';
globalThis.fetch = async (url, options) => {
  assert.equal(String(url), 'https://storage.example/api/v1/storage/records/cache/public-feed');
  const headers = new Headers(options.headers);
  assert.equal(headers.get('X-Api-Key'), 'synthetic.unit.key');
  assert.equal(headers.get('X-Tenant-ID'), '11111111-1111-4111-8111-111111111111');
  assert.equal(options.redirect, 'error');
  let current;
  try { current = readFileSync(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (options.method === 'GET') return current
    ? new Response(current, {status:200, headers:{ETag:etag(current), 'Content-Length':String(current.length)}})
    : new Response(null, {status:404});
  assert.equal(options.method, 'PUT');
  if (current ? headers.get('If-Match') !== etag(current) : headers.get('If-None-Match') !== '*')
    return new Response(null, {status:412});
  const bytes = Buffer.from(options.body);
  writeFileSync(file, bytes);
  return new Response(null, {status:current ? 204 : 201, headers:{ETag:etag(bytes)}});
};
