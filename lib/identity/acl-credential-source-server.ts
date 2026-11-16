import { linkId, type UnsignedRecord } from "sociacl-ids";
import { authenticatedHistoryContexts, type DelegationTrust } from "./acl-delegation-source-server";
import { parseLinkedCredential, type LinkedSessionSource, type LinkedCredential } from "./linked-session-admission";
import { readBoundedIdentityJson } from "./bounded-json";
import type { ForumRecoverySnapshot } from "./forum-recovery-history";

export type AclCredentialConfig = Readonly<{ origin: string; tenant: string; source: string; apiKey: string }>;
const uuid = (v: unknown) => typeof v === "string" && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v) && v !== "00000000-0000-0000-0000-000000000000";
const record = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw Error("Invalid credential source response");
  return v as Record<string, unknown>;
};
const canonical = (value: unknown): string => JSON.stringify(value, (_, item) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const ids = (rows: readonly unknown[]) => rows.map(row => {
  const id = linkId(record(row) as UnsignedRecord);
  if (!id.ok) throw Error("Invalid credential link");
  return id.value;
}).sort();

/** The fixed source is an entire authority domain. No owner-selected export and
 * no service-provided witness key can establish login uniqueness. */
export function createAclCredentialSource(input: AclCredentialConfig, suppliedTrust: DelegationTrust,
  fetcher: typeof fetch = fetch, clock = () => Math.floor(Date.now() / 1000)): LinkedSessionSource {
  const config = Object.freeze({ ...input }), trust = structuredClone(suppliedTrust);
  const origin = new URL(config.origin);
  if (Object.keys(config).sort().join() !== "apiKey,origin,source,tenant" || origin.protocol !== "https:" ||
      origin.origin !== config.origin || origin.port || origin.username || origin.password || !uuid(config.tenant) ||
      !uuid(config.source) || !/^[\x21-\x7e]{1,4096}$/.test(config.apiKey)) throw Error("Invalid credential source configuration");
  return Object.freeze({ async read(credential: LinkedCredential, at: number, parent: AbortSignal) {
    const selected = parseLinkedCredential(credential);
    if (!selected || !Number.isSafeInteger(at) || at < 0 || clock() !== at) throw Error("Invalid credential evaluation");
    const deadline = performance.now() + 5000;
    let work = 0;
    const budget = (cost = 1) => {
      work += cost;
      if (work > 4096 || performance.now() >= deadline) throw Error("Credential verification budget exceeded");
      parent.throwIfAborted();
    };
    const signal = AbortSignal.any([parent, AbortSignal.timeout(5000)]);
    let response: Response | undefined;
    const bounded = <T>(work: Promise<T>) => new Promise<T>((resolve, reject) => {
      const abort = () => reject(Error("Credential source cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
    try {
      signal.throwIfAborted();
      response = await bounded(fetcher(config.origin + "/api/v1/acl/sociacl/credential-source/read", {
        method: "POST", redirect: "error", cache: "no-store", credentials: "omit", signal,
        headers: { "X-Api-Key": config.apiKey, "X-Tenant-ID": config.tenant, "Content-Type": "application/json", "Accept-Encoding": "identity" },
        body: JSON.stringify({ credential: selected, evaluatedAt: at }),
      }).then(value => { if (signal.aborted) { void value.body?.cancel().catch(() => {}); signal.throwIfAborted(); } return value; }));
      signal.throwIfAborted();
      if (!response) throw Error("Missing credential source response");
      if (response.status !== 200 || response.headers.get("content-type")?.split(";")[0] !== "application/json" ||
          ![null, "identity"].includes(response.headers.get("content-encoding"))) throw Error("Unavailable credential source");
      const value = record(await bounded(readBoundedIdentityJson(response, 4 * 1024 * 1024, signal)));
      if (Object.keys(value).sort().join() !== "authorityDigest,snapshot,source,tenant,trust,version" || value.version !== 1 ||
          value.tenant !== config.tenant || value.source !== config.source || typeof value.authorityDigest !== "string" ||
          !/^[a-f0-9]{64}$/.test(value.authorityDigest)) throw Error("Foreign credential source");
      const snapshot = record(value.snapshot), echoed = parseLinkedCredential(snapshot.credential);
      if (Object.keys(snapshot).sort().join() !== "completeThrough,credential,history,links,revocations" || snapshot.completeThrough !== at ||
          JSON.stringify(echoed) !== JSON.stringify(selected) || !Array.isArray(snapshot.links) || snapshot.links.length > 128 ||
          !Array.isArray(snapshot.revocations) || snapshot.revocations.length > 1024) throw Error("Incomplete credential source");
      const history = record(snapshot.history) as unknown as ForumRecoverySnapshot;
      // Bound each synchronous native resolver invocation as well as aggregate work.
      if (!Array.isArray(history.accounts) || history.accounts.some(account =>
          !Array.isArray(account.rotations) || account.rotations.length > 32 ||
          !Array.isArray(account.revocations) || account.revocations.length > 32) ||
          !Array.isArray(history.links) || history.links.length > 128)
        throw Error("Credential verification budget exceeded");
      const { accounts, contextFor } = authenticatedHistoryContexts(history, structuredClone(trust), at, budget);
      const matching = history.links.filter(raw => {
        const row = record(raw);
        if (selected.kind === "wallet") return row.kind === "wallet" && row.address === selected.address;
        return row.kind === "oidc" && record(row.cred).iss === selected.iss && record(row.cred).tenant === selected.tenant && record(row.cred).sub === selected.sub;
      });
      if (JSON.stringify(ids(matching)) !== JSON.stringify(ids(snapshot.links))) throw Error("Omitted credential candidate");
      const revocations = [...accounts.values()].flatMap(account => account.revocations);
      if (JSON.stringify(revocations.map(row => canonical(row)).sort()) !== JSON.stringify(snapshot.revocations.map(row => canonical(row)).sort()))
        throw Error("Incomplete credential revocations");
      const principal = accounts.keys().next().value;
      if (!principal) throw Error("Missing authority accounts");
      const context = contextFor(principal, at);
      signal.throwIfAborted();
      if (clock() !== at) throw Error("Credential source expired");
      return { completeThrough: at, links: matching, revocations, context };
    } finally {
      if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
    }
  } });
}
