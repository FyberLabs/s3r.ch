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

/** Match Gun SEA's JWK representation using the browser's native WebCrypto.
 * Avoid the legacy CommonJS loader and its runtime-dependent shim imports.
 */
export async function createSeaPair(): Promise<SeaPair> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("Secure browser cryptography unavailable");
  const signing = await subtle.generateKey({name: "ECDSA", namedCurve: "P-256"}, true, ["sign", "verify"]);
  const encryption = await subtle.generateKey({name: "ECDH", namedCurve: "P-256"}, true, ["deriveKey"]);
  const sign = await subtle.exportKey("jwk", signing.privateKey);
  const enc = await subtle.exportKey("jwk", encryption.privateKey);
  if (!sign.x || !sign.y || !sign.d || !enc.x || !enc.y || !enc.d) throw new Error("SEA key generation failed");
  return {pub: `${sign.x}.${sign.y}`, priv: sign.d, epub: `${enc.x}.${enc.y}`, epriv: enc.d};
}
