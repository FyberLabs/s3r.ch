/**
 * Local Gun SEA P-256 pair. This is mesh identity, not the Ethereum SIWE key
 * (different curves). Do not persist privkeys. Do not call
 * `user.recall({ sessionStorage: true })` — that stores the plaintext pair.
 * Do not put `priv` / `epriv` on the public Gun graph.
 * Not wired into the UI in this slice.
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
    `TODO: gun/sea import is not available in this runtime (${String(last)}). createSeaPair is not wired to the UI.`,
  );
}

export async function createSeaPair(): Promise<SeaPair> {
  const sea = await loadSea();
  return sea.pair();
}
