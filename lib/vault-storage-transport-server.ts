/** Server-only service credential adapter; never import into a browser bundle. */
import { createSpanopticonRecordStore } from './spanopticon-record-store-server';
import { createSpanopticonObjectStore } from './spanopticon-object-store-server';
import type { VaultHeadTransport } from './vault-storage-client';
/** Both products must receive the same deployment-selected storage space.
 * This supplies transport only. A public user proxy must enforce its own owner
 * authorization; do not expose the tenant service key to an end-user session. */
export function createSpanopticonVaultTransport(config: Readonly<{ origin: string; tenant: string; apiKey: string }>, fetcher: typeof fetch = fetch): VaultHeadTransport {
  const records = createSpanopticonRecordStore(config, fetcher), objects = createSpanopticonObjectStore(config, fetcher);
  const transport: VaultHeadTransport = {
    read: (id, signal) => records.get('vault', id, signal),
    write: (id, bytes, expected, signal) => records.put('vault', id, bytes, expected, signal),
    putObject: (id, bytes, signal) => objects.put(id, bytes, signal),
    getObject: (id, signal) => objects.get(id, signal),
  };
  return Object.freeze(transport);
}
