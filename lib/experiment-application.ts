import { createHmac, createPublicKey, randomUUID } from "node:crypto";
import { anonymousExperimentCookie } from "./experiment-state";
import { createCachedExperimentProvider } from "./experiment-cache-provider";
import { createExperimentRecords } from "./experiment-records";
import { createExperimentPrivacy, clearExperimentCookies } from "./experiment-privacy";
import { createIdentityTokenVerifier } from "./identity/sea-session-verifier";
import { getIdentitySecret } from "./identity/secret";
import { readSeaSessionCookie, seaSessionCookieNames } from "./identity/sea-session-http";
import { createExperimentOutbox } from "./experiment-outbox";
import { createExperimentRuntime, type ExperimentSink } from "./experiment-runtime";
import { createManualExperimentClient } from "./experiment-telemetry";

export const s3rchExperiments = [{ key: "landing-message", control: "control", variants: ["control", "create"], metrics: ["feed_opened"] }];
const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
function result(value: unknown, status = 200, cookies: readonly string[] = []) {
  const response = new Response(JSON.stringify(value), { status, headers: { ...headers, "Content-Type": "application/json" } });
  for (const cookie of cookies) response.headers.append("Set-Cookie", cookie);
  return response;
}
function consentCookieLifetime(cookies: readonly string[], expires: number) {
  const seconds = Math.max(0, Math.floor((expires - Date.now()) / 1000));
  return cookies.map(cookie => cookie.replace(/Max-Age=[0-9]+/, `Max-Age=${seconds}`));
}
function origin(value: string | undefined) {
  const url = new URL(value ?? "");
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) throw Error("Invalid experiment origin");
  return url.origin;
}
function publicKey(value: string | undefined) {
  if (!value || value.includes("PRIVATE")) throw Error("Experiment public key required");
  const key = createPublicKey(value);
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") throw Error("Experiment public key required");
  return key;
}
/** Only server-owned environment variables configure authority and transport. */
export async function createExperimentApplication(env: Record<string, string | undefined>) {
  const site = origin(env.S3RCH_EXPERIMENT_ORIGIN);
  const tenant = env.S3RCH_EXPERIMENT_TENANT ?? "";
  const rawSecret = env.S3RCH_EXPERIMENT_SECRET ?? "";
  if (!/^[a-f0-9]{64}$/.test(rawSecret)) throw Error("Experiment secret required");
  const secret = Buffer.from(rawSecret, "hex");
  const previousRaw = env.S3RCH_EXPERIMENT_PREVIOUS_SECRETS?.split(",") ?? [];
  if (previousRaw.length > 3 || previousRaw.some(value => !/^[a-f0-9]{64}$/.test(value))) throw Error("Invalid previous experiment secrets");
  const previousSecrets = previousRaw.map(value => Buffer.from(value, "hex"));
  const sessions = createExperimentPrivacy({ tenant, origin: site, secret, previousSecrets });
  const verifier = createIdentityTokenVerifier({ origin: site, secret: getIdentitySecret({ ...env, NODE_ENV: "production" }) });
  async function identity(request: Request) {
    const token = readSeaSessionCookie(request);
    if (!token) {
      const name = seaSessionCookieNames()[0];
      if ((request.headers.get("cookie") ?? "").split(";").some(value => value.trim().startsWith(name + "="))) throw Error("SEA session unavailable");
      return { subject: null, expiresAt: Infinity };
    }
    const claims = await verifier.claims(token, "s3rch-identity-session-v1", 300);
    return { subject: claims.key, expiresAt: claims.expiresAt };
  }
  const records = createExperimentRecords({ origin: env.S3RCH_EXPERIMENT_STORAGE_ORIGIN ?? "", tenant,
    cacheKey: env.S3RCH_EXPERIMENT_CACHE_KEY ?? "", outboxKey: env.S3RCH_EXPERIMENT_OUTBOX_KEY ?? "" });
  const sinks: Record<string, ExperimentSink> = {};
  for (const [name, connection, v2] of [["primary", env.APPLICATIONINSIGHTS_CONNECTION_STRING, env.S3RCH_EXPERIMENT_PRIMARY_V2],
    ["secondary", env.S3RCH_EXPERIMENT_SECONDARY_CONNECTION, env.S3RCH_EXPERIMENT_SECONDARY_V2]]) {
    if (!connection && name === "secondary") continue;
    const client = await createManualExperimentClient(connection ?? "");
    sinks[name!] = { supportedEventTypes: v2 === "1" ? ["experiment.exposure.v1", "experiment.conversion.v2"] : ["experiment.exposure.v1"],
      async send(event) { await client.trackEvent({ name: event.event_type, properties: event.payload, eventId: event.event_id }); } };
  }
  const provider = await createCachedExperimentProvider({ records: records.cache, publicKey: publicKey(env.S3RCH_EXPERIMENT_PUBLIC_KEY), domain: `s3rch-${tenant.replaceAll("-", "")}` });
  let active = 0;
  function outbox(privacy: { id: string; retentionUntil: number }, identityExpires = Infinity) {
    return createExperimentOutbox({ store: records.outbox, consentId: privacy.id, retentionUntil: privacy.retentionUntil, sinks,
      permitted: () => Date.now() < privacy.retentionUntil && Date.now() < identityExpires * 1000, healthy: key => provider.guardrailHealthy(key) });
  }
  return Object.freeze({
    close: provider.close,
    async get(request: Request, enabled = true) {
      if (new URL(request.url).origin !== site) return result({ enabled: false }, 403);
      const privacy = await sessions.privacy(request.headers.get("cookie") ?? "");
      if (!enabled) return result({ enabled: false, consented: privacy !== null, variant: "control" });
      let authenticated = false;
      try { authenticated = (await identity(request)).subject !== null; } catch { /* Status still permits withdrawal. */ }
      return result({ enabled: true, consented: privacy !== null, authenticated, variant: "control" });
    },
    async post(request: Request, enabled = true) {
      if (new URL(request.url).origin !== site || request.headers.get("origin") !== site) return result({ error: "Same-origin request required" }, 403);
      if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json" || request.headers.has("content-encoding")) return result({ error: "JSON request required" }, 415);
      if (active >= 8) return result({ error: "Experiment service busy" }, 429);
      active++;
      try {
        const reader = request.body?.getReader(); if (!reader) return result({ error: "Request required" }, 400);
        const chunks: Uint8Array[] = []; let size = 0;
        const deadline = Date.now() + 3000;
        async function nextPart() {
          let timer: ReturnType<typeof setTimeout>;
          try { return await Promise.race([reader!.read(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(Error("Request timeout")), Math.max(0, deadline - Date.now())); })]); }
          finally { clearTimeout(timer!); }
        }
        try { while (true) { const part = await nextPart(); if (part.done) break; size += part.value.byteLength; if (size > 16384) return result({ error: "Request too large" }, 413); chunks.push(part.value); } }
        finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!body || typeof body !== "object" || Array.isArray(body)) return result({ error: "Invalid request" }, 400);
        const cookies = request.headers.get("cookie") ?? "";
        if (body.action === "consent" && Object.keys(body).sort().join() === "action,allowed" && typeof body.allowed === "boolean") {
          // Replacing consent first revokes the old record, including pending
          // delivery. Expired but correctly signed consent can still be erased.
          if (body.allowed && !enabled) return result({ error: "Experiments disabled" }, 503);
          const old = await sessions.privacy(cookies, true);
          if (old) await outbox(old).erase();
          return result({ consented: body.allowed }, 200, [...clearExperimentCookies(), ...(body.allowed ? [await sessions.consent(), `${anonymousExperimentCookie}=${randomUUID()}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=86400`] : [])]);
        }
        if (!enabled) return result({ error: "Experiments disabled" }, 503);
        const fields = Object.keys(body).sort().join();
        if (body.action === "evaluate" ? fields !== "action" : body.action === "exposure" || body.action === "conversion" ? fields !== "action,display,eventId" : true) return result({ error: "Invalid request" }, 400);
        let principal;
        try { principal = await identity(request); } catch { return result({ error: "Verified SEA session unavailable" }, 401); }
        const privacy = await sessions.privacy(cookies);
        if (!privacy) return result({ variant: "control", consented: false });
        const queue = outbox(privacy, principal.expiresAt);
        if (!await queue.active()) return result({ variant: "control", consented: false }, 200, clearExperimentCookies());
        const displayed = typeof body.display === "string" ? await sessions.displayed(body.display, privacy.id) : null;
        const open = createExperimentRuntime({ tenant, secret: createHmac("sha256", secret).update(privacy.id).digest(), previousSecrets: previousSecrets.map(key => createHmac("sha256", key).update(privacy.id).digest()), provider, experiments: s3rchExperiments,
          outbox: queue, sinks: [{ supportedEventTypes: Object.values(sinks).every(s => s.supportedEventTypes.includes("experiment.conversion.v2")) ? ["experiment.exposure.v1", "experiment.conversion.v2"] : ["experiment.exposure.v1"],
            async send() { await queue.flush(); } }] });
        const context = await open({ cookies, verifiedPrincipal: principal.subject, privacy: () => ({ consent: Date.now() < principal.expiresAt * 1000, deletionRequested: false, retentionUntil: privacy.retentionUntil }),
          ...(displayed ? { verifiedDisplay: displayed } : {}) });
        if (body.action === "evaluate") {
          const assignment = await context.evaluate("landing-message");
          return result({ variant: assignment.variant, cohort: assignment.assignment_hash, expiresAt: Math.min(provider.validUntil() ?? 0, principal.expiresAt, Math.floor(privacy.retentionUntil / 1000)), consented: true, authenticated: principal.subject !== null, display: await sessions.display(assignment, privacy.id) }, 200, consentCookieLifetime(await context.cookies(), privacy.retentionUntil));
        }
        if (!displayed || typeof body.eventId !== "string" || body.action === "conversion" && principal.subject === null) return result({ error: "Displayed assignment required" }, 400);
        const accepted = await context.record("landing-message", body.eventId, body.action === "conversion" ? "feed_opened" : undefined);
        return result({ accepted }, accepted ? 200 : 503, consentCookieLifetime(await context.cookies(), privacy.retentionUntil));
      } catch { return result({ error: "Experiment service unavailable" }, 503); }
      finally { active--; }
    },
  });
}
let application: Promise<Awaited<ReturnType<typeof createExperimentApplication>>> | undefined;
export async function s3rchExperimentRequest(request: Request) {
  const enabled = process.env.S3RCH_EXPERIMENTS_ENABLED === "1";
  if (!enabled && request.method === "GET" && !(request.headers.get("cookie") ?? "").includes("__Host-s3rch-experiment-consent="))
    return result({ enabled: false, consented: false, variant: "control" });
  try {
    application ??= createExperimentApplication(process.env).catch(error => { application = undefined; throw error; });
    const app = await application;
    return request.method === "GET" ? app.get(request, enabled) : app.post(request, enabled);
  } catch { return result({ error: "Experiment service unavailable" }, 503); }
}
