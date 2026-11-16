/** Private, unmounted transport. Native assignment/consent verification is mandatory. */
import { randomUUID } from "node:crypto";
export type DependencyMeasurementRow = Readonly<{
  ActionId:string; Experiment:string; Variant:string;
  Metric:"dependency_failure_rate"|"error_rate"|"latency_ms"; ObservedAt:number; Value:number;
}>;
export type VerifiedDependencyRead = Readonly<{
  variant:string; recordName:string;
  /** Native owner checks current verified assignment, identity and consent. */
  current:()=>boolean;
  signal?:AbortSignal;
}>;
export type DependencyObserverOptions = {
  enabled?:boolean;
  binding?:Readonly<{relayOrigin:string; relaySecret:string; experiment:string;
    variants:readonly string[]; operation:string; recordPrefix:string; sampleEvery:number}>;
  /** Synchronous enqueue into the separate, bounded private server DCR publisher. */
  publish?:(rows:readonly DependencyMeasurementRow[])=>boolean;
  transport?:typeof fetch;
  /** Server construction dependency for deterministic unit tests; never request input. */
  createAction?:()=>string;
};
const label = /^[a-z][a-z0-9_-]{0,63}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const unavailable = () => Error("Measured dependency unavailable");

export function createExperimentDependencyObserver(options:DependencyObserverOptions = {}) {
  // Disabled construction does not inspect credentials or require publisher resources.
  if(options.enabled !== true) return Object.freeze({read:async (_input:VerifiedDependencyRead):Promise<Response|null> => null, close() {}});
  const raw = options.binding;
  if(!raw || !label.test(raw.experiment) || !label.test(raw.operation) ||
     !/^[a-z][a-z0-9-]{0,62}-$/.test(raw.recordPrefix) || !/^[a-f0-9]{64}$/.test(raw.relaySecret) ||
     !Number.isSafeInteger(raw.sampleEvery) || raw.sampleEvery < 1 || raw.sampleEvery > 10000 ||
     raw.variants.length < 2 || raw.variants.length > 8 || new Set(raw.variants).size !== raw.variants.length ||
     raw.variants.some(value=>!label.test(value)) || typeof options.publish !== "function") throw Error("Invalid private observer binding");
  let origin:URL;
  try {origin = new URL(raw.relayOrigin);} catch {throw Error("Invalid private observer origin");}
  if(origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw Error("Invalid private observer origin");
  const binding = Object.freeze({...raw,variants:Object.freeze([...raw.variants])});
  const endpoint = origin.origin + "/v1/observe", transport = options.transport ?? fetch;
  const createAction = options.createAction ?? randomUUID, publish = options.publish;
  const running = new Set<AbortController>();
  let closed = false, lastIssued = -1;
  const admitted:number[] = [];
  return Object.freeze({
    close() {closed = true; for(const controller of running) controller.abort();},
    async read(input:VerifiedDependencyRead):Promise<Response|null> {
      if(closed) throw unavailable();
      const current = () => {try{return !closed && !input.signal?.aborted && input.current() === true;}catch{return false;}};
      const variant = input.variant, recordName = input.recordName;
      if(!current() || !binding.variants.includes(variant) || typeof recordName !== "string" ||
         !recordName.startsWith(binding.recordPrefix) || !/^[a-f0-9]{64}$/.test(recordName.slice(binding.recordPrefix.length))) throw unavailable();
      const action = createAction();
      if(!uuid.test(action)) throw unavailable();
      if(BigInt("0x"+action.replaceAll("-","")) % BigInt(binding.sampleEvery)) return null;
      const issued = Math.floor(Date.now()/1000);
      if(issued < lastIssued) return null;
      lastIssued = issued;
      while(admitted.length && admitted[0] <= issued-60) admitted.shift();
      // A timed-out transport that ignores abort still occupies its bounded slot.
      if(admitted.length >= 60 || running.size >= 8) return null;
      const attribution = JSON.stringify({action,experiment:binding.experiment,variant,operation:binding.operation,
        issued,target:recordName.slice(binding.recordPrefix.length)});
      if(attribution.length > 512) throw unavailable();
      admitted.push(issued);
      const controller = new AbortController(); running.add(controller);
      const started = performance.now(); let observed = false, failed = true;
      let timer:ReturnType<typeof setTimeout>;
      let rejectAbort:(reason:Error)=>void = () => {};
      const onAbort = () => rejectAbort(unavailable());
      const abort = () => controller.abort();
      const interrupted = new Promise<never>((_resolve,reject)=>{rejectAbort=reject;});
      controller.signal.addEventListener("abort",onAbort,{once:true});
      input.signal?.addEventListener("abort",abort,{once:true});
      timer = setTimeout(abort,3000);
      const work = (async()=>{
        let response:Response|undefined;
        try {
          if(!current() || controller.signal.aborted) throw unavailable();
          response = await transport(endpoint,{method:"POST",body:"",redirect:"error",cache:"no-store",credentials:"omit",signal:controller.signal,
            headers:{"Accept-Encoding":"identity",Authorization:`Bearer ${binding.relaySecret}`,"Content-Type":"application/octet-stream","X-Experiment-Attribution":attribution}});
          if(controller.signal.aborted) throw unavailable();
          if(response.headers.get("x-experiment-action") !== action) throw unavailable();
          observed = true;
          if((response.headers.get("content-encoding") ?? "identity").trim().toLowerCase() !== "identity") throw unavailable();
          if(response.redirected || response.status >= 300 && response.status < 400) throw unavailable();
          const reader = response.body?.getReader(), chunks:Uint8Array[] = []; let size = 0;
          const cancel = () => {void reader?.cancel().catch(()=>{});};
          controller.signal.addEventListener("abort",cancel,{once:true});
          try {
            if(reader) while(true) {
              const part = await reader.read();
              if(controller.signal.aborted) throw unavailable();
              if(part.done) break;
              size += part.value.byteLength; if(size > 65536) throw unavailable(); chunks.push(part.value);
            }
          } finally {controller.signal.removeEventListener("abort",cancel);cancel();reader?.releaseLock();}
          if(!current() || controller.signal.aborted) throw unavailable();
          const etag = response.headers.get("etag");
          if(etag && etag.length > 256) throw unavailable();
          const result = new Response(size ? Buffer.concat(chunks) : null,{status:response.status,
            headers:{"Content-Type":"application/octet-stream","Cache-Control":"no-store",...(etag ? {ETag:etag} : {})}});
          failed = response.status >= 500;
          return result;
        } finally {
          if(response?.body && !response.body.locked) void response.body.cancel().catch(()=>{});
          running.delete(controller);
        }
      })();
      try {return await Promise.race([work,interrupted]);}
      catch {throw unavailable();}
      finally {
        clearTimeout(timer);input.signal?.removeEventListener("abort",abort);controller.signal.removeEventListener("abort",onAbort);controller.abort();
        // Missing relay acknowledgement is missing evidence, not an invented measurement.
        if(observed && current()) {
          const duration = performance.now()-started, at = Math.floor(Date.now()/1000);
          if(Number.isFinite(duration) && duration >= 0 && at >= issued && at-issued <= 60) {
            const values = [["latency_ms",duration],["error_rate",Number(failed)],["dependency_failure_rate",Number(failed)]] as const;
            const rows = Object.freeze(values.map(([Metric,Value])=>Object.freeze({ActionId:action,Experiment:binding.experiment,Variant:variant,Metric,ObservedAt:at,Value})));
            try {publish(rows);} catch { /* An out-of-band delivery failure cannot change the read. */ }
          }
        }
      }
    },
  });
}
