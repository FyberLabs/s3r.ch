import { createHash } from "node:crypto";
import { ManagedIdentityCredential } from "@azure/identity";
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import { p256 } from "@noble/curves/nist.js";
import { parseSquadPilotConfig, type SquadPilotConfig } from "./squad-pilot-config";
import { createForumAuthority } from "./identity/forum-authority";
import { createSquadCommitStore, LedgerEvaluationExpired } from "./squad-commit-store";
import { createBlobSquadCommitStore, createBlobSquadSessionReplayStore, createBlobInventoryStore } from "./delegation-blob-inventory";
import { createBlobCancellationOutboxStore, createBlobReplacementGrantStore } from "./delegation-blob-outbox";
import { createSquadSessionReplayStore } from "./identity/squad-session-replay";
import { createSquadHttpServices } from "./squad-http-services";
import { parseForumAuthority } from "./identity/forum-authority-records";

export const squadPilotNamespace = (c: SquadPilotConfig) => createHash("sha256").update(JSON.stringify(["s3rch-pilot-ledger-v1", c.origin, c.squad.forumId, c.squad.owner])).digest("hex");
/** Never accepts browser-selected accounts, paths, policies or signing keys. */
export function createSquadPilotServer(c: SquadPilotConfig, container: Pick<ContainerClient, "getBlockBlobClient">, clock = () => Math.floor(Date.now() / 1000)) {
  const config = structuredClone(c), namespace = squadPilotNamespace(config);
  const source = createSquadCommitStore(createBlobSquadCommitStore(container, namespace), config.squad, clock, "authoritative-ledger");
  const consume = createSquadSessionReplayStore(createBlobSquadSessionReplayStore(container, namespace), clock);
  const services = createSquadHttpServices({ squad: config.squad, origin: config.origin, config: config.authority, secret: config.sessionSecret,
    clock, consume, read: source.read, assignments: { source, runtime: {
      config: config.authority, clock,
      async sign(kind, fields) {
        const record = { ...fields, sig: "pending" }, parsed = parseForumAuthority(kind, record);
        if (!parsed) throw Error("invalid authority signing intent");
        record.sig = Buffer.from(p256.sign(parsed.bytes, Buffer.from(config.ownerSigningKey, "hex"), { prehash: true, format: "compact" })).toString("base64url");
        return { kind, soul: parsed.soul, record };
      },
      operationStores(id) {
        if (!/^[0-9a-f]{32}$/.test(id)) throw Error("invalid operation ID");
        const operationNamespace = createHash("sha256").update(JSON.stringify([namespace, id])).digest("hex");
        return { inventory: createBlobInventoryStore(container, operationNamespace),
          cancellations: createBlobCancellationOutboxStore(container, namespace), grants: createBlobReplacementGrantStore(container, namespace) };
      },
    } } });
  return { config, source, services };
}
export function pilotContainer(env = process.env) {
  const account = env.S3RCH_SQUAD_BLOB_ACCOUNT, container = env.S3RCH_SQUAD_BLOB_CONTAINER;
  if (!account || !/^[a-z0-9]{3,24}$/.test(account) || !container || !/^[a-z0-9](?:[a-z0-9]|-(?!-)){1,61}[a-z0-9]$/.test(container)) throw Error("pilot primary storage unavailable");
  return new BlobServiceClient(`https://${account}.blob.core.windows.net`, new ManagedIdentityCredential()).getContainerClient(container);
}
// No build-time or import-time secret/storage reads. Key Vault references are
// resolved by App Service. Invalid/missing material never initializes state.
let cached: { identity: string; server: ReturnType<typeof createSquadPilotServer> } | undefined;
export function getSquadPilotServer() {
  const identity = JSON.stringify([process.env.S3RCH_SQUAD_PILOT, process.env.S3RCH_SQUAD_BLOB_ACCOUNT, process.env.S3RCH_SQUAD_BLOB_CONTAINER]);
  if (cached?.identity === identity) return cached.server;
  cached = undefined;
  const config = parseSquadPilotConfig(process.env.S3RCH_SQUAD_PILOT);
  if (!config) return null;
  const server = createSquadPilotServer(config, pilotContainer());
  cached = { identity, server }; return server;
}

// Health requests arrive at arbitrary offsets within the evaluation second.
// If a read expires, discard it and verify a new primary read once.
export async function squadPilotReady(pilot: {
  config: Pick<SquadPilotConfig, "authority" | "squad">;
  source: Pick<ReturnType<typeof createSquadCommitStore>, "read">;
},
  signal: AbortSignal, clock = () => Math.floor(Date.now() / 1000)) {
  const authority = createForumAuthority(pilot.config.authority, clock);
  for (let attempt = 0; attempt < 2; attempt++) {
    signal.throwIfAborted();
    const at = clock();
    try {
      const snapshot = await pilot.source.read(at, signal);
      const result = await authority.refresh(snapshot, at);
      signal.throwIfAborted();
      if (result.diagnostics.length) return false;
      if (clock() === at) return result.ok && authority.graph.ownerOf(pilot.config.squad.forumId) === pilot.config.squad.owner;
      if (!result.ok && result.reason !== "superseded" && result.reason !== "incomplete-authority") return false;
    } catch (error) {
      if (!(error instanceof LedgerEvaluationExpired)) throw error;
    }
    if (clock() <= at) return false;
  }
  return false;
}
