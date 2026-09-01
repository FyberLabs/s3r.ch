/**
 * Local Gun SEA P-256 pair. This is mesh identity, not the Ethereum SIWE key
 * (different curves). After SIWE, persist the pair in origin IndexedDB only
 * (see idb.ts). Legacy lab records may still be plaintext; PRF wrap replaces
 * `seaPair` on disk (wrap.ts).
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

export function isSeaPair(value: unknown): value is SeaPair {
  if (!value || typeof value !== "object") return false;
  const sea = value as Record<string, unknown>;
  return (
    typeof sea.pub === "string" &&
    sea.pub.length > 0 &&
    typeof sea.priv === "string" &&
    sea.priv.length > 0 &&
    typeof sea.epub === "string" &&
    sea.epub.length > 0 &&
    typeof sea.epriv === "string" &&
    sea.epriv.length > 0
  );
}

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
