/** Private backend binding only. No Next route, UI or default activation. */
import { createHash, createPublicKey, sign, verify, timingSafeEqual, type KeyObject } from "node:crypto";
import { isIP } from "node:net";
import { createIdentityTokenVerifier } from "./identity/sea-session-verifier";
import { createForumAuthority, type ForumAuthorityConfig } from "./identity/forum-authority";
import { createAclStatementSource, type AclStatementConfig } from "./acl-statement-source-server";
import { isForumObjectId } from "./identity/forum-check";
import { roomAuthorityDiagnosticsBlock } from "./room-authority-diagnostics";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };
const exact = (value: unknown, keys: string): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join() === keys;
export function streamCanonical(value: unknown): string {
  const sorted = (v: any): any => Array.isArray(v) ? v.map(sorted) : v && typeof v === "object"
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sorted(v[k])])) : v;
  return JSON.stringify(sorted(value)).replace(/[\u007f-\uffff]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}
const equal = (a: string, b: string) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createStreamAuthority(input: {
  tenant: string; forum: string; origin: string; sessionSecret: string;
  source: AclStatementConfig; authority: ForumAuthorityConfig;
  serviceKey: string; signingKey: KeyObject;
}, fetcher: typeof fetch = fetch, clock = () => Math.floor(Date.now() / 1000)) {
  const { tenant, forum, serviceKey, signingKey } = input;
  if (!uuid.test(tenant) || tenant === "00000000-0000-0000-0000-000000000000" || input.source.tenant !== tenant ||
      !isForumObjectId(forum, "forum") || !/^[\x21-\x7e]{32,512}$/.test(serviceKey) ||
      signingKey.type !== "private" || signingKey.asymmetricKeyType !== "ed25519") throw Error("Private stream binding required");
  const source = createAclStatementSource(input.source, fetcher, clock);
  const identity = createIdentityTokenVerifier({ origin: input.origin, secret: input.sessionSecret, clock });
  const policy = structuredClone(input.authority);
  // This opaque Core subject binds the actual SEA key, native session ID and
  // expiry. Each Check resolves its current canonical principal from history;
  // rotation, expired proof and cross-tenant reuse cannot preserve admission.
  const subjectKey = createPublicKey(signingKey);
  const subjectBytes = (value: string) => Buffer.from("s3rch-stream-subject-v1\0" + tenant + "\0" + value);
  const seal = (proof: { key: string; id: string; expiresAt: number }) => {
    const value = `s1.${proof.key}.${proof.expiresAt}.${proof.id}`;
    return value + "." + sign(null,subjectBytes(value),signingKey).toString("base64url");
  };
  const unseal = (value: unknown, at: number) => {
    if (typeof value !== "string" || value.length > 256) throw Error();
    const parts = value.split("."), payload = parts.slice(0, -1).join(".");
    if (parts.length !== 6 || parts[0] !== "s1" || !/^[0-9a-f]{64}$/.test(parts[4]) ||
        !/^[1-9][0-9]{0,15}$/.test(parts[3]) || (!/^[A-Za-z0-9_-]{86}$/.test(parts[5]) || !verify(null,subjectBytes(payload),subjectKey,Buffer.from(parts[5],"base64url")))) throw Error();
    const expiresAt = Number(parts[3]);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= at || expiresAt > at + 300) throw Error();
    return { key: parts[1] + "." + parts[2], expiresAt };
  };
  // Only requests queued before a read begins share that read. Later arrivals
  // get a new snapshot: neither completed snapshots nor allow decisions persist.
  type Fresh = { at: number; snapshot: Awaited<ReturnType<typeof source.read>>["snapshot"];
    fence: string; authority: ReturnType<typeof createForumAuthority>;
    result: Awaited<ReturnType<ReturnType<typeof createForumAuthority>["refresh"]>> };
  type Waiting = { signal: AbortSignal; resolve(value: Fresh): void; reject(error: unknown): void };
  let waiting: Waiting[] = [], reading = false, scheduled = false;
  const schedule = () => {
    if (reading || scheduled || !waiting.length) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; void flush(); }, 1);
  };
  const flush = async () => {
    const cohort = waiting.filter(item => !item.signal.aborted); waiting = [];
    if (!cohort.length) return;
    reading = true;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(650)]);
    const cancelEmpty = () => { if (cohort.every(item => item.signal.aborted)) controller.abort(); };
    for (const item of cohort) item.signal.addEventListener("abort", cancelEmpty, { once: true });
    try {
      for (;;) {
        signal.throwIfAborted(); const at = clock();
        try {
          const { snapshot, fence } = await source.read(at, signal);
          const authority = createForumAuthority(policy, clock), result = await authority.refresh(snapshot, at);
          signal.throwIfAborted();
          if (clock() !== at) continue;
          if (!result.ok) throw Error();
          for (const item of cohort) item.resolve({ at, snapshot, fence, authority, result });
          break;
        } catch (error) {
          // A rollover invalidates the old read; retry only within the same
          // finite operation budget, never by accepting an older snapshot.
          if (!signal.aborted && clock() !== at) continue;
          throw error;
        }
      }
    } catch (error) { for (const item of cohort) item.reject(error); }
    finally {
      for (const item of cohort) item.signal.removeEventListener("abort", cancelEmpty);
      reading = false; schedule();
    }
  };
  const fresh = (signal: AbortSignal) => new Promise<Fresh>((resolve, reject) => {
    signal.throwIfAborted();
    const finish = () => signal.removeEventListener("abort", abort);
    const item: Waiting = { signal, resolve(value) { finish(); resolve(value); }, reject(error) { finish(); reject(error); } };
    const abort = () => { waiting = waiting.filter(row => row !== item); item.reject(Error("Authority cancelled")); };
    signal.addEventListener("abort", abort, { once: true }); waiting.push(item); schedule();
  });
  let active = 0;
  return async (request: Request): Promise<Response> => {
    const deny = () => Response.json({ error: "stream-authority-unavailable" }, { status: 403, headers });
    if (request.method !== "POST" || new URL(request.url).pathname !== "/internal/streams/authority" ||
        !equal(request.headers.get("x-stream-service-key") ?? "", serviceKey) || active >= 32) return deny();
    active++;
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(650)]);
    try {
      if (request.headers.get("content-type")?.split(";")[0] !== "application/json" ||
          ![null,"identity"].includes(request.headers.get("content-encoding")) || !request.body) throw Error();
      const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      const abort = () => { void reader.cancel().catch(() => {}); };
      signal.addEventListener("abort", abort, { once: true });
      try {
        for (;;) {
          signal.throwIfAborted(); const part = await reader.read(); signal.throwIfAborted();
          if (part.done) break;
          size += part.value.length; if (size > 4096) throw Error(); chunks.push(part.value);
        }
      } finally { signal.removeEventListener("abort", abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      let at = clock();
      if (!value || value.version !== 1 || typeof value.nonce !== "string" || !/^[a-f0-9]{64}$/.test(value.nonce)) throw Error();
      let proof: { key: string; expiresAt: number }, subject: string;
      if (value.operation === "identity" && exact(value,"nonce,operation,version")) {
        const bearer = request.headers.get("authorization") ?? "";
        if (!bearer.startsWith("Bearer ")) throw Error();
        const claims = await identity.claims(bearer.slice(7), "s3rch-identity-session-v1", 300);
        proof = claims; subject = seal(claims);
      } else if (value.operation === "check" && exact(value,"nonce,operation,scope,version")) {
        const scope = value.scope;
        if (!exact(scope,"action,ip,room,subject") || !exact(scope.subject,"principal,tenant") || scope.subject.tenant !== tenant ||
            !["publish","read"].includes(scope.action) || typeof scope.ip !== "string" || !isIP(scope.ip) ||
            !isForumObjectId(scope.room,"room")) throw Error();
        subject = scope.subject.principal; proof = unseal(subject,at);
      } else throw Error();
      let current = await fresh(signal);
      while (clock() !== current.at) current = await fresh(signal);
      const { snapshot, fence, authority, result } = current; at = current.at;
      if (proof.expiresAt <= at) throw Error();
      const room = value.operation === "check" ? value.scope.room : undefined;
      signal.throwIfAborted();
      if (clock() !== at || !result.ok || roomAuthorityDiagnosticsBlock(result.diagnostics,snapshot,authority.graph,room)) throw Error();
      const principal = authority.graph.principalForKey(proof.key,at);
      if (!principal || authority.graph.writerKey(principal,at,at) !== proof.key || !authority.graph.ownerOf(forum) ||
          !authority.graph.checkForumSee(forum,principal,at).allowed) throw Error();
      const base = { version:1, nonce:value.nonce, operation:value.operation, evaluatedAt:at };
      let claims: object;
      if (value.operation === "identity") claims = { ...base, tenant, principal:subject };
      else {
        if (!authority.graph.checkDirectSee(room!,principal,at).allowed ||
            (value.scope.action === "publish" && (!authority.graph.checkPost(forum,principal,at).allowed || !authority.graph.checkPost(room!,principal,at).allowed))) throw Error();
        claims = { ...base, scope:value.scope, allowed:true, validUntil:Math.min(at+3600,proof.expiresAt),
          revision:createHash("sha256").update(streamCanonical({ fence, principal, scope:value.scope })).digest("hex") };
      }
      signal.throwIfAborted(); if (clock() !== at) throw Error();
      const signature = sign(null,Buffer.from("core-stream-authority-v1\0" + streamCanonical(claims)),signingKey).toString("base64");
      return Response.json({ claims, signature }, { headers });
    } catch { return deny(); }
    finally { active--; }
  };
}
