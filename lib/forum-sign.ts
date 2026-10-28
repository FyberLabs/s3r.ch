/**
 * Gun SEA signatures for forum mesh rows. The signature is a sibling `sig`
 * on the existing soul. It is not a second tree. Unsigned rows are ignored.
 */

import { isSeaPubkey } from "@/lib/identity/forum-check";
import type { SeaPair } from "@/lib/identity/sea";

type SeaApi = {
  sign?: (data: unknown, pair: SeaPair) => Promise<unknown>;
  verify?: (data: unknown, pub: string | { pub: string }) => Promise<unknown>;
};

function apiOf(mod: SeaApi & { default?: SeaApi }): SeaApi | null {
  if (typeof mod.sign === "function" && typeof mod.verify === "function") return mod;
  if (mod.default && typeof mod.default.sign === "function" && typeof mod.default.verify === "function") {
    return mod.default;
  }
  return null;
}

async function seaApi(): Promise<SeaApi> {
  const mod = (await import("gun/sea")) as SeaApi & { default?: SeaApi };
  const imported = apiOf(mod);
  if (imported) return imported;
  if (typeof window !== "undefined") return {};
  const { createRequire } = await import("node:module");
  const required = createRequire(`${process.cwd()}/package.json`)("gun/sea") as SeaApi & {
    default?: SeaApi;
  };
  return apiOf(required) ?? {};
}

export async function signForumRecord(record: unknown, pair: SeaPair): Promise<string | null> {
  if (!isSeaPubkey(pair.pub)) return null;
  const sea = await seaApi();
  if (!sea.sign) return null;
  const signed = await sea.sign(record, pair);
  return typeof signed === "string" && signed.startsWith("SEA") ? signed : null;
}

/** Returns the signed record, or null when the pubkey did not sign it. */
export async function readForumSignature(sig: unknown, pub: string): Promise<unknown> {
  if (typeof sig !== "string" || !sig.startsWith("SEA")) return null;
  if (!isSeaPubkey(pub)) return null;
  const sea = await seaApi();
  if (!sea.verify) return null;
  const data = await sea.verify(sig, pub);
  if (data === undefined || data === null || data === false) return null;
  return data;
}

export function signatureOf(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const sig = (data as { sig?: unknown }).sig;
  return typeof sig === "string" && sig.startsWith("SEA") ? sig : null;
}
