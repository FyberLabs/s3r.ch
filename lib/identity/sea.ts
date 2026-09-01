/**
 * Local Gun SEA P-256 pair. This is mesh identity, not the Ethereum SIWE key
 * (different curves). After SIWE, persist the pair in origin IndexedDB only
 * (see idb.ts). Lab slice may store plaintext on-device; WebAuthn PRF wrap
 * replaces that later (wrap.ts).
 *
 * Never call `user.recall({ sessionStorage: true })`.
 * Never write `priv` / `epriv` onto the public Gun graph.
 */

export type SeaPair = {
  pub: string;
  priv: string;
  epub: string;
  epriv: string;
};

type SeaModule = {
  pair?: () => Promise<SeaPair>;
  default?: { pair?: () => Promise<SeaPair> };
};

async function loadSea(): Promise<{ pair: () => Promise<SeaPair> }> {
  const candidates = ["gun/sea", "gun/sea.js"];
  let last: unknown;
  for (const spec of candidates) {
    try {
      const mod = (await import(spec)) as SeaModule;
      const sea = mod.default ?? mod;
      if (typeof sea.pair === "function") {
        return { pair: sea.pair.bind(sea) };
      }
    } catch (error) {
      last = error;
    }
  }
  throw new Error(
    `gun/sea import is not available in this runtime (${String(last)}).`,
  );
}

export async function createSeaPair(): Promise<SeaPair> {
  const sea = await loadSea();
  return sea.pair();
}
