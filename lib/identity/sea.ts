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
  // Literal specifier lets Next and browser test bundlers include the module.
  const mod = (await import("gun/sea.js")) as SeaModule;
  const sea = mod.default ?? mod;
  if (typeof sea.pair !== "function") throw new Error("SEA module unavailable");
  return { pair: sea.pair.bind(sea) };
}

export async function createSeaPair(): Promise<SeaPair> {
  const sea = await loadSea();
  const pair = await sea.pair();
  if (!isSeaPair(pair)) throw new Error("SEA key generation failed");
  return pair;
}
