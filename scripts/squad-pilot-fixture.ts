/** Legacy Blob fixture for CI and explicitly invoked operator tools only.
 * Application routes must never import this module. */
import { createHash } from "node:crypto";
import type { ContainerClient } from "@azure/storage-blob";
import type { SquadPilotConfig } from "../lib/squad-pilot-config";
import type { IdentityReplay } from "../lib/identity/spanopticon-replay-server";
import { getIdentitySecret } from "../lib/identity/secret";
import { createSquadCommitStore } from "../lib/squad-commit-store";
import { createBlobSquadCommitStore, createBlobSquadSessionReplayStore, createBlobInventoryStore } from "../lib/delegation-blob-inventory";
import { createBlobCancellationOutboxStore, createBlobReplacementGrantStore } from "../lib/delegation-blob-outbox";
import { createSquadSessionReplayStore } from "../lib/identity/squad-session-replay";
import { identitySessionNamespace } from "../lib/identity/replay-namespace";
import { createSquadHttpServices } from "../lib/squad-http-services";
import { createSquadAssignmentService } from "../lib/squad-assignment-service";
export const squadPilotNamespace = (c: SquadPilotConfig) => createHash("sha256").update(JSON.stringify(["s3rch-pilot-ledger-v1", c.origin, c.squad.forumId, c.squad.owner])).digest("hex");
/** Storage-only operator entrypoint. It neither reads an identity secret nor
 * constructs an issuer; callers retain the existing ledger verification rules. */
export function createSquadPilotSource(c: SquadPilotConfig, container: Pick<ContainerClient, "getBlockBlobClient">, clock = () => Math.floor(Date.now() / 1000)) {
  const config = structuredClone(c);
  return createSquadCommitStore(createBlobSquadCommitStore(container, squadPilotNamespace(config)), config.squad, clock, "authoritative-ledger");
}
export function createSquadPilotFixture(c: SquadPilotConfig, container: Pick<ContainerClient, "getBlockBlobClient">,
  clock = () => Math.floor(Date.now() / 1000),
  identitySecret = getIdentitySecret({ IDENTITY_SESSION_SECRET: process.env.IDENTITY_SESSION_SECRET, NODE_ENV: "production" }),
  replay?: IdentityReplay) {
  const config = structuredClone(c), namespace = squadPilotNamespace(config);
  const source = createSquadPilotSource(config, container, clock);
  const consume = replay?.consume ?? createSquadSessionReplayStore(createBlobSquadSessionReplayStore(container, identitySessionNamespace(config.origin)), clock);
  const services = createSquadHttpServices({ squad: config.squad, origin: config.origin, config: config.authority,
    secret: identitySecret, clock, consume, challengeDomain: replay?.challengeDomain, read: source.read });
  const assignments = createSquadAssignmentService({ squad: config.squad, origin: config.origin,
    authenticate: services.authenticate, source, runtime: {
      config: config.authority, clock,
      operationStores(id) {
        if (!/^[0-9a-f]{32}$/.test(id)) throw Error("invalid operation ID");
        const operationNamespace = createHash("sha256").update(JSON.stringify([namespace, id])).digest("hex");
        return { inventory: createBlobInventoryStore(container, operationNamespace),
          cancellations: createBlobCancellationOutboxStore(container, namespace), grants: createBlobReplacementGrantStore(container, namespace) };
      },
    } });
  return { backend: "fixture" as const, config, source, services: { ...services, assignments } };
}
