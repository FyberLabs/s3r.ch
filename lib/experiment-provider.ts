import { verify, type KeyObject } from "node:crypto";
import { GrowthbookProvider } from "@openfeature/growthbook-provider";
import { NOOP_PROVIDER, OpenFeature } from "@openfeature/server-sdk";
import type { FeatureDefinitions } from "@growthbook/growthbook";
import type { ExperimentDefinition } from "./experiment-state";

type Configuration = { version: 1; audience: "s3r.ch"; sequence: number; issuedAt: number; expiresAt: number;
  experiments: Array<ExperimentDefinition & { weights: number[]; disabled: boolean }> };
const slug = /^[a-z][a-z0-9_-]{0,63}$/;
function exact(row: unknown, keys: string): row is Record<string, unknown> {
  return !!row && typeof row === "object" && !Array.isArray(row) && Object.keys(row).sort().join() === keys;
}
function configuration(raw: string, now: number): Configuration {
  const value = JSON.parse(raw);
  if (!exact(value, "audience,experiments,expiresAt,issuedAt,sequence,version") || value.version !== 1 || value.audience !== "s3r.ch" ||
      !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1 ||
      !Number.isSafeInteger(value.issuedAt) || (value.issuedAt as number) > now ||
      !Number.isSafeInteger(value.expiresAt) || (value.expiresAt as number) <= now ||
      (value.expiresAt as number) <= (value.issuedAt as number) ||
      (value.expiresAt as number) - (value.issuedAt as number) > 300 ||
      !Array.isArray(value.experiments) || value.experiments.length > 8) throw Error("Invalid flag payload");
  for (const row of value.experiments) {
    if (!exact(row, "control,disabled,key,variants,weights") || typeof row.key !== "string" || !slug.test(row.key) ||
        typeof row.control !== "string" || !slug.test(row.control) || typeof row.disabled !== "boolean" ||
        !Array.isArray(row.variants) || row.variants.length < 2 || row.variants.length > 8 ||
        !row.variants.every(v => typeof v === "string" && slug.test(v)) || new Set(row.variants).size !== row.variants.length ||
        !row.variants.includes(row.control) || !Array.isArray(row.weights) || row.weights.length !== row.variants.length ||
        !row.weights.every(w => typeof w === "number" && Number.isFinite(w) && w >= 0 && w <= 1) ||
        Math.abs(row.weights.reduce((a, b) => a + b, 0) - 1) > 1e-9) throw Error("Invalid experiment configuration");
  }
  if (new Set(value.experiments.map(row => row.key)).size !== value.experiments.length) throw Error("Duplicate experiment");
  return value as Configuration;
}
function provider(config: Configuration | null) {
  const features: FeatureDefinitions = {};
  for (const row of config?.experiments ?? []) features[row.key] = { defaultValue: row.control, rules: row.disabled ? [] : [{
    key: row.key, variations: [...row.variants], weights: [...row.weights], hashAttribute: "targetingKey", hashVersion: 2,
  }] };
  // Supplied in-memory payload, no API host/client key, streaming or analytics
  // callback. Only the first-party adapter decides when exposure occurred.
  return new GrowthbookProvider({ disableCache: true, log: () => {} }, { payload: { features }, streaming: false, skipCache: true });
}

/** One server-owned domain per application adapter. The control-plane transport
 * supplies detached Ed25519 signatures; no request can nominate its own key. */
export async function createExperimentProvider(input: { publicKey: KeyObject; domain: string; clock?: () => number }) {
  if (input.publicKey.type !== "public" || input.publicKey.asymmetricKeyType !== "ed25519" || typeof input.domain !== "string" || !slug.test(input.domain)) throw Error("Explicit flag trust configuration required");
  const clock = input.clock ?? (() => Math.floor(Date.now() / 1000));
  let current: Configuration | null = null, closed = false, pending: Promise<unknown> = Promise.resolve();
  await OpenFeature.setProviderAndWait(input.domain, provider(null));
  const client = OpenFeature.getClient(input.domain);
  function active() { return !closed && current && current.expiresAt > clock() ? current : null; }
  return Object.freeze({
    refresh(raw: string, signature: string): Promise<boolean> {
      const work = pending.then(async () => {
        if (closed || typeof raw !== "string" || Buffer.byteLength(raw) > 32768 || typeof signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
        try {
          if (!verify(null, Buffer.from(raw), input.publicKey, Buffer.from(signature, "base64url"))) return false;
          const next = configuration(raw, clock());
          if (current && next.sequence <= current.sequence) return false;
          await OpenFeature.setProviderAndWait(input.domain, provider(next));
          current = next;
          return true;
        } catch { return false; }
      });
      pending = work;
      return work;
    },
    validUntil(): number | null { return active()?.expiresAt ?? null; },
    definitions(): readonly ExperimentDefinition[] {
      return Object.freeze((active()?.experiments ?? []).map(row => Object.freeze({ key: row.key, control: row.control, variants: Object.freeze([...row.variants]) })));
    },
    guardrailHealthy(key: string): boolean { return active()?.experiments.some(row => row.key === key && !row.disabled) ?? false; },
    async choose(key: string, targetingKey: string): Promise<string> {
      await pending;
      const snapshot = active();
      const config = snapshot?.experiments.find(row => row.key === key);
      if (!config || !/^[a-f0-9]{64}$/.test(targetingKey)) throw Error("Experiment unavailable");
      const result = await client.getStringDetails(key, config.control, { targetingKey });
      // A refresh, expiry or close during evaluation invalidates this choice.
      await pending;
      if (active() !== snapshot || result.errorCode || !config.variants.includes(result.value)) throw Error("Experiment unavailable");
      return result.value;
    },
    async close() {
      closed = true;
      await pending;
      await OpenFeature.setProviderAndWait(input.domain, NOOP_PROVIDER);
    },
  });
}
