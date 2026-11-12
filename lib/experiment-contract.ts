import { createHmac } from "node:crypto";

const label = /^[a-z][a-z0-9_-]{0,63}$/;
const hash = /^[a-f0-9]{64}$/;
export type ExperimentEventType = "experiment.exposure.v1" | "experiment.conversion.v1";
export type ExperimentPayload = Readonly<{
  experiment_key: string; variant: string; assignment_hash: string;
  surface: "s3r.ch"; release_tag?: string;
}>;

/** Matches controlplane-events' experiment.assignment.v1 HMAC contract.
 * The identifier and random, server-only secret must never enter event sinks. */
export function hashExperimentAssignment(identifier: string, secret: Uint8Array): string {
  if (!(secret instanceof Uint8Array) || secret.byteLength < 32 ||
      typeof identifier !== "string" || !identifier || identifier.length > 4096) throw Error("Invalid assignment configuration");
  return createHmac("sha256", secret).update("experiment.assignment.v1\0").update(identifier, "utf8").digest("hex");
}

/** Validate the entire object, rather than silently dropping private fields. */
export function parseExperimentPayload(input: unknown): ExperimentPayload | null {
  if (!input || typeof input !== "object") return null;
  let row: Record<string, unknown>;
  try {
    if (Array.isArray(input)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Reflect.ownKeys(descriptors).some(key => typeof key !== "string")) return null;
    if (Object.values(descriptors).some(field => !field.enumerable || !("value" in field))) return null;
    row = Object.fromEntries(Object.entries(descriptors).map(([key, field]) => [key, field.value]));
  } catch { return null; }
  const fields = Object.keys(row).sort().join(",");
  if (fields !== "assignment_hash,experiment_key,surface,variant" &&
      fields !== "assignment_hash,experiment_key,release_tag,surface,variant") return null;
  if (typeof row.experiment_key !== "string" || !label.test(row.experiment_key) ||
      typeof row.variant !== "string" || !label.test(row.variant) ||
      typeof row.assignment_hash !== "string" || !hash.test(row.assignment_hash) || row.surface !== "s3r.ch" ||
      ("release_tag" in row && (typeof row.release_tag !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(row.release_tag)))) return null;
  return Object.freeze({ experiment_key: row.experiment_key, variant: row.variant,
    assignment_hash: row.assignment_hash, surface: "s3r.ch",
    ...("release_tag" in row ? { release_tag: row.release_tag as string } : {}) });
}

/** Call only after a response actually shows the variant or its configured
 * conversion occurs. Evaluation alone must not publish an exposure. */
export function createExperimentEmitter(sink: (type: ExperimentEventType, payload: ExperimentPayload) => Promise<void>) {
  return async (type: ExperimentEventType, input: unknown): Promise<boolean> => {
    if (type !== "experiment.exposure.v1" && type !== "experiment.conversion.v1") return false;
    const payload = parseExperimentPayload(input);
    if (!payload) return false;
    try { await sink(type, payload); return true; } catch { return false; }
  };
}
