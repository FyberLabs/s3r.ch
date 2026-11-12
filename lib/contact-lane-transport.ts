/** Spanopticon ciphertext transport only. Callers still decrypt and authenticate. */
export type LaneCiphertext = Readonly<{ id: string; ciphertext: Uint8Array }>;
const HEX = /^[0-9a-f]{64}$/;
const MAX_BYTES = 65536;
const MAX_LANE_BYTES = 1024 * 1024;
const MAX_RESPONSE = 1500000;

async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`Contact lane unavailable (${response.status})`);
  if (!response.body) throw new Error('Missing contact lane response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_RESPONSE) throw new Error('Contact lane response too large');
      chunks.push(value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

/** The caller supplies the trusted Spanopticon HTTPS origin, never a peer URL. */
export function createContactLaneTransport(spanopticonOrigin: string, fetcher: typeof fetch = fetch) {
  const base = new URL(spanopticonOrigin);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new Error('Expected a Spanopticon HTTPS origin');
  }
  function endpoint(laneId: string) {
    if (!HEX.test(laneId)) throw new Error('Invalid opaque lane ID');
    return `${base.origin}/api/v1/acl/sociacl/contact-lanes/${laneId}/messages`;
  }
  function options(): RequestInit {
    return { credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(15000) };
  }
  return {
    async append(laneId: string, ciphertext: Uint8Array): Promise<string> {
      const url = endpoint(laneId);
      if (!(ciphertext instanceof Uint8Array) || ciphertext.length < 32 || ciphertext.length > MAX_BYTES) {
        throw new Error('Invalid ciphertext size');
      }
      const body = new Uint8Array(ciphertext); // Snapshot caller-owned mutable bytes.
      const expected = await digest(body);
      const result = await boundedJson(await fetcher(url, { ...options(), method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' }, body }));
      if (!result || typeof result !== 'object' || !('id' in result) || result.id !== expected) {
        throw new Error('Ciphertext digest mismatch');
      }
      return expected;
    },
    async read(laneId: string): Promise<readonly LaneCiphertext[]> {
      const result = await boundedJson(await fetcher(endpoint(laneId), { ...options(), method: 'GET' }));
      if (!result || typeof result !== 'object' || !('messages' in result) || !Array.isArray(result.messages) || result.messages.length > 128) {
        throw new Error('Invalid contact lane response');
      }
      const rows: LaneCiphertext[] = []; const seen = new Set<string>(); let total = 0;
      for (const row of result.messages) {
        if (!row || typeof row.id !== 'string' || !HEX.test(row.id) || seen.has(row.id) || typeof row.ciphertext !== 'string' ||
            row.ciphertext.length > 87384 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(row.ciphertext)) {
          throw new Error('Invalid contact lane ciphertext');
        }
        const raw = atob(row.ciphertext);
        if (btoa(raw) !== row.ciphertext || raw.length < 32 || raw.length > MAX_BYTES) throw new Error('Invalid ciphertext size or encoding');
        total += raw.length;
        if (total > MAX_LANE_BYTES) throw new Error('Contact lane response too large');
        const ciphertext = Uint8Array.from(raw, ch => ch.charCodeAt(0));
        if (await digest(ciphertext) !== row.id) throw new Error('Ciphertext digest mismatch');
        seen.add(row.id); rows.push(Object.freeze({ id: row.id, ciphertext }));
      }
      // Matching a transport digest is NOT sender authentication or a grant.
      return Object.freeze(rows);
    },
  };
}
