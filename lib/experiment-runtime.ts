import { createHmac } from "node:crypto";
import { createExperimentState, type ExperimentDefinition } from "./experiment-state";
import { parseExperimentPayload, type ExperimentEventType, type ExperimentPayload, type ExperimentPrivacy } from "./experiment-contract";

type Provider = {
  refresh(): Promise<boolean>;
  guardrailHealthy(key: string): boolean;
  choose(key: string, target: string): Promise<string>;
};
export type ExperimentEvent = Readonly<{ event_id: string; event_type: ExperimentEventType; payload: ExperimentPayload }>;
export type ExperimentSink = Readonly<{ supportedEventTypes: readonly ExperimentEventType[]; send(event: ExperimentEvent): Promise<void> }>;
export type ExperimentOutbox = Readonly<{
  /** Atomically create or compare with the existing event. A different body must fail. */
  retain(event: ExperimentEvent): Promise<void>;
}>;
export type ProductExperiment = ExperimentDefinition & Readonly<{ metrics: readonly string[] }>;
const id = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Deployment-owned scope and compiled controls. Identity and privacy are resolved
 * by the product server for each request; browser bodies cannot supply either. */
export function createExperimentRuntime(input: {
  tenant: string; secret: Uint8Array; previousSecrets?: readonly Uint8Array[];
  provider: Provider; experiments: readonly ProductExperiment[];
  outbox: ExperimentOutbox; sinks: readonly ExperimentSink[];
  clock?: () => number;
}) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.tenant) ||
      input.tenant === "00000000-0000-0000-0000-000000000000" || input.secret.byteLength < 32 ||
      input.experiments.some(e => !e.metrics.length || new Set(e.metrics).size !== e.metrics.length ||
        e.metrics.some(m => !/^[a-z][a-z0-9_-]{0,63}$/.test(m)))) throw Error("Invalid experiment binding");
  // State signed for one deployment tenant is unusable in another tenant, even
  // when an operator accidentally reuses the root secret.
  const scope = (key: Uint8Array) => createHmac("sha256", key).update(`s3rch.experiments.v1\0${input.tenant}`).digest();
  const open = createExperimentState({ secret: scope(input.secret), previousSecrets: input.previousSecrets?.map(scope), clock: input.clock });
  const definitions = input.experiments.map(e => ({ ...e, variants: [...e.variants], metrics: [...e.metrics] }));
  const sinks = input.sinks.map(s => ({ send: s.send.bind(s), supportedEventTypes: [...s.supportedEventTypes] }));
  const now = input.clock ?? (() => Math.floor(Date.now() / 1000));
  return async (request: { cookies: string; verifiedPrincipal: string | null; privacy(): ExperimentPrivacy | null; verifiedDisplay?: ExperimentPayload }) => {
    const permitted = () => {
      try { const p = request.privacy(); return p?.consent === true && p.deletionRequested === false &&
        Number.isSafeInteger(p.retentionUntil) && p.retentionUntil > now() * 1000; } catch { return false; }
    };
    const state = await open(request.cookies, request.verifiedPrincipal, definitions);
    if (permitted()) { try { await input.provider.refresh(); } catch { /* Compiled control remains available. */ } }
    const displayed = new Map<string, ExperimentPayload>();
    const select = async (key: string) => {
      const value = await state.evaluate(key, target => input.provider.choose(key, target), permitted() && input.provider.guardrailHealthy(key));
      // A disable, expiry or privacy change while evaluation awaited overrides
      // a retained cohort without changing its attribution hash.
      const shown = permitted() && input.provider.guardrailHealthy(key) ? value : Object.freeze({ ...value, variant: definitions.find(e => e.key === key)!.control });
      displayed.set(key, shown);
      return shown;
    };
    return Object.freeze({
      evaluate: select,
      cookies: async () => permitted() ? state.cookies() : [],
      assignmentKeyVersion: state.assignmentKeyVersion,
      /** Only the product's displayed/conversion path calls this. A report is
       * untrusted analytics and is never forwarded to a guardrail controller. */
      async record(key: string, actionId: string, conversion?: string): Promise<boolean> {
        if (!id.test(actionId) || !permitted() || !input.provider.guardrailHealthy(key) || !sinks.length) return false;
        const definition = definitions.find(e => e.key === key);
        if (!definition || conversion !== undefined && !definition.metrics.includes(conversion)) return false;
        const type: ExperimentEventType = conversion === undefined ? "experiment.exposure.v1" : "experiment.conversion.v2";
        // Named conversions are never relabeled as legacy v1 conversions.
        if (sinks.some(s => !s.supportedEventTypes.includes(type))) return false;
        const assigned = displayed.get(key) ?? request.verifiedDisplay;
        const retained = state.assignment(key);
        if (!assigned || !retained || assigned.experiment_key !== key || assigned.variant !== retained.variant || assigned.assignment_hash !== retained.assignment_hash) return false;
        const payload = parseExperimentPayload({ ...assigned, ...(conversion === undefined ? {} : { conversion_key: conversion }) }, type);
        if (!payload || !permitted() || !input.provider.guardrailHealthy(key)) return false;
        const event = Object.freeze({ event_id: actionId, event_type: type, payload });
        try {
          await input.outbox.retain(event);
          for (const sink of sinks) {
            if (!permitted() || !input.provider.guardrailHealthy(key)) return false;
            await sink.send(event);
          }
          return true;
        } catch { return false; }
      },
    });
  };
}
