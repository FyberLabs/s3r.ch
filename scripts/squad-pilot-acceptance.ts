import assert from "node:assert/strict";
import { p256 } from "@noble/curves/nist.js";
import type { ContainerClient } from "@azure/storage-blob";
import { createSquadPilotServer } from "../lib/squad-pilot-server";
import { parseSquadPilotConfig } from "../lib/squad-pilot-config";
import { createSquadSessionClient } from "../lib/squad-session-client";
import { createHttpAssignmentClient } from "../lib/assignment-client";
import { seaToPrincipalKey } from "../lib/identity/forum-check";
import { parseForumAuthority, type AuthorityKind } from "../lib/identity/forum-authority-records";

/** Runs against the owned emulator only; real cookie proofs and primary Blob
 * adapters, separate service/client instances and durable restart assertions. */
export async function testSquadPilot(container: ContainerClient, phase: "write" | "read") {
  const at = 1700000060, origin = "https://s3r.ch";
  const pair = (n: number) => { const secret = Buffer.alloc(32, n), k = p256.getPublicKey(secret, false);
    const pub = Buffer.from(k.slice(1, 33)).toString("base64url") + "." + Buffer.from(k.slice(33)).toString("base64url");
    return { pub, priv: secret.toString("base64url"), epub: pub, epriv: secret.toString("base64url") }; };
  const owner = pair(53), previous = pair(54), replacement = pair(55), witness = pair(56);
  const squad = { owner: owner.pub, forumId: `forum_${seaToPrincipalKey(owner.pub)}_${"f".repeat(32)}`, label: "Full pilot acceptance" };
  const config = parseSquadPilotConfig(JSON.stringify({ version: 1, origin, squad, ownerSigningKey: Buffer.alloc(32, 53).toString("hex"),
    authority: { keys: [{ kid: "synthetic", kty: "EC", crv: "P-256", x: witness.pub.split(".")[0], y: witness.pub.split(".")[1], notBefore: at - 100, notAfter: at + 1000 }],
      policy: { allowedDomains: [], allowedUris: [], allowedChainIds: [] }, pinnedIssuers: [] } }))!;
  const server = () => createSquadPilotServer(config, container, () => at, "e".repeat(64));
  const pilot = server(), scope = { forum: squad.forumId, owner: squad.owner }, id = "e".repeat(32);
  const sign = (kind: AuthorityKind, fields: Record<string, unknown>) => {
    const record = { ...fields, sig: "pending" }, p = parseForumAuthority(kind, record)!;
    record.sig = Buffer.from(p256.sign(p.bytes, Buffer.alloc(32, 53), { prehash: true, format: "compact" })).toString("base64url");
    return { kind, soul: p.soul, record };
  };
  if (phase === "write") await pilot.source.initialize({ version: 1, revision: 0, forum: scope.forum, owner: scope.owner, assignee: previous.pub, destinations: [scope.forum], operation: null, receipts: {}, children: {}, usedOperations: [], rows: [
    sign("object", { owner: scope.owner, object: scope.forum, issuedAt: at - 1 }),
    ...(["see", "post"] as const).map(kind => sign(kind, { owner: scope.owner, object: scope.forum, accessor: previous.pub, stated: 1, hamState: 1, issuedAt: at - 1, from: at - 1, until: at + 600 })),
  ] }, { completeThrough: at - 3600, links: [], accounts: [owner, previous, replacement].map(p => ({ principal: p.pub, rotations: [], revocations: [], genesisEpubBindings: [] })) });
  async function client(key: ReturnType<typeof pair>) {
    const cookies = new Map<string, string>(), independent = server();
    const fetcher: typeof fetch = async (url, init) => {
      const action = String(url).split("/").at(-1)!;
      const headers = new Headers(init?.headers); headers.set("origin", origin); headers.set("cookie", [...cookies].map(([k, v]) => `${k}=${v}`).join("; "));
      const request = new Request(origin + url, { ...init, headers });
      const response = action === "challenge" || action === "exchange" || action === "logout" ? await independent.services[action](request)
        : await independent.services.assignments!(action as Parameters<NonNullable<typeof independent.services.assignments>>[0], request);
      for (const cookie of response.headers.getSetCookie()) { const [name, value] = cookie.split(";")[0].split("="); if (value) cookies.set(name, value); else cookies.delete(name); }
      return response;
    };
    const session = createSquadSessionClient({ base: "/session", origin, squad, fetch: fetcher, clock: () => at });
    assert.equal(await session.signIn(key), true);
    return { session, assignment: createHttpAssignmentClient({ base: "/assignment", fetch: fetcher }) };
  }
  const ownerClient = await client(owner), oldClient = await client(previous), newClient = await client(replacement);
  if (phase === "write") {
    assert.equal((await ownerClient.assignment.read(scope)).assignee, previous.pub);
    assert.equal(await oldClient.assignment.readChild(scope, scope.forum), null);
    assert.equal((await ownerClient.assignment.start(scope, id, replacement.pub, 0)).status, "complete");
  }
  assert.equal((await ownerClient.assignment.read(scope)).assignee, replacement.pub);
  assert.equal((await ownerClient.assignment.resume(scope, id, replacement.pub)).status, "complete");
  await assert.rejects(oldClient.assignment.readChild(scope, scope.forum));
  assert.equal(await newClient.assignment.readChild(scope, scope.forum), null);
  assert.equal(await ownerClient.session.logout(), true);
  await assert.rejects(ownerClient.assignment.read(scope));
  console.log(`Pilot session/assignment primary Blob ${phase} acceptance passed`);
}
