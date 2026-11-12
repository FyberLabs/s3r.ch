/** Operator-only tooling. Never import into a route. Secrets are written only
 * to a new private directory; no deterministic keys or HTTP signing endpoint. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { AzureCliCredential } from "@azure/identity";
import { BlobServiceClient } from "@azure/storage-blob";
import { p256 } from "@noble/curves/nist.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createAssignmentJournal } from "../lib/delegation-journal";
import { parseForumAuthority, type AuthorityKind } from "../lib/identity/forum-authority-records";
import { createForumAuthority } from "../lib/identity/forum-authority";
import { seaToPrincipalKey } from "../lib/identity/forum-check";
import { parseSquadPilotConfig } from "../lib/squad-pilot-config";
import { createSquadPilotSource } from "../lib/squad-pilot-server";
import type { InventoryStore } from "../lib/delegation-inventory";

async function main() {
  const [action, directory, ...args] = process.argv.slice(2);
  if (!directory) throw Error("Usage: squad-pilot.ts prepare NEW_PRIVATE_DIRECTORY HTTPS_ORIGIN | provision DIRECTORY ACCOUNT CONTAINER | verify DIRECTORY ACCOUNT CONTAINER | admit-history DIRECTORY ACCOUNT CONTAINER HISTORY_JSON");
  const file = (name: string) => resolve(directory, name);
  if (action === "prepare") {
    if (args.length !== 1 || new URL(args[0]).origin !== args[0] || !args[0].startsWith("https://")) throw Error("Fixed HTTPS origin required");
    mkdirSync(directory, { mode: 0o700 }); // Refuse an existing directory or partial provisioning.
    const pair = () => {
      const priv = p256.utils.randomSecretKey(), epriv = p256.utils.randomSecretKey();
      const pub = (s: Uint8Array) => { const k = p256.getPublicKey(s, false); return Buffer.from(k.slice(1, 33)).toString("base64url") + "." + Buffer.from(k.slice(33)).toString("base64url"); };
      return { pub: pub(priv), priv: Buffer.from(priv).toString("base64url"), epub: pub(epriv), epriv: Buffer.from(epriv).toString("base64url") };
    };
    const identities = Array.from({ length: 4 }, () => {
      const walletPrivateKey = generatePrivateKey();
      return { ...pair(), walletPrivateKey, address: privateKeyToAccount(walletPrivateKey).address };
    }), owner = identities[0], witness = pair(), now = Math.floor(Date.now() / 1000);
    const config = { version: 1, origin: args[0], squad: { forumId: `forum_${seaToPrincipalKey(owner.pub)}_${randomBytes(16).toString("hex")}`, owner: owner.pub, label: "Synthetic agent pilot" },
      authority: { keys: [{ kid: `pilot-${randomBytes(8).toString("hex")}`, kty: "EC", crv: "P-256", x: witness.pub.split(".")[0], y: witness.pub.split(".")[1], notBefore: now, notAfter: now + 86400 * 90 }],
        policy: { allowedDomains: [new URL(args[0]).host], allowedUris: [args[0]], allowedChainIds: ["84532"] }, pinnedIssuers: [] } };
    parseSquadPilotConfig(JSON.stringify(config));
    writeFileSync(file("deployment.json"), JSON.stringify(config), { mode: 0o600, flag: "wx" });
    writeFileSync(file("operator.json"), JSON.stringify({ identities, witness }), { mode: 0o600, flag: "wx" });
    console.log("Prepared private pilot material. No remote state or settings changed."); return;
  }
  if (!["provision", "verify", "admit-history"].includes(action) || args.length !== (action === "admit-history" ? 3 : 2)) throw Error("Invalid operator action");
  const [account, containerName] = args;
  if (!/^[a-z0-9]{3,24}$/.test(account) || !/^[a-z0-9](?:[a-z0-9]|-(?!-)){1,61}[a-z0-9]$/.test(containerName)) throw Error("Invalid primary account/container");
  const c = parseSquadPilotConfig(readFileSync(file("deployment.json"), "utf8")); if (!c) throw Error("Missing deployment contract");
  const container = new BlobServiceClient(`https://${account}.blob.core.windows.net`, new AzureCliCredential({ subscription: process.env.AZURE_SUBSCRIPTION_ID })).getContainerClient(containerName);
  const source = createSquadPilotSource(c, container);
  if (action === "provision") {
    const { identities } = JSON.parse(readFileSync(file("operator.json"), "utf8"));
    if (identities.length !== 4 || identities[0].pub !== c.squad.owner) throw Error("Pilot identities do not match configuration");
    const now = Math.floor(Date.now() / 1000), owner = c.squad.owner, forum = c.squad.forumId;
    const destinations = [forum, ...["subtask", "update", "prompt", "artifact", "need"].map(kind => `${kind}_${seaToPrincipalKey(owner)}_${randomBytes(16).toString("hex")}`)];
    const sign = (kind: AuthorityKind, fields: Record<string, unknown>) => {
      const record = { ...fields, sig: "pending" }, p = parseForumAuthority(kind, record); if (!p) throw Error("Invalid provisioning record");
      record.sig = Buffer.from(p256.sign(p.bytes, Buffer.from(identities[0].priv, "base64url"), { prehash: true, format: "compact" })).toString("base64url");
      return { kind, soul: p.soul, record };
    };
    let held: { text: string; etag: string } | null = null;
    const memory: InventoryStore = { read: async () => held, compareAndSwap: async (etag, text) => { if (etag !== null || held) return false; held = { text, etag: "seed" }; return true; } };
    const journal = await createAssignmentJournal(memory).initialize({ forum, owner, assignee: identities[1].pub, destinations, rows: destinations.flatMap(object => [
      sign("object", { owner, object, issuedAt: now }),
      ...identities.slice(1, 2).flatMap((p: { pub: string }) => (["see", "post"] as const).map(kind => sign(kind, { owner, object, accessor: p.pub, stated: 1, hamState: 1, from: now, until: now + 86400 * 30, issuedAt: now }))),
    ]) });
    await source.initialize(journal, { completeThrough: now, links: [], accounts: identities.map((p: { pub: string }) => ({ principal: p.pub, rotations: [], revocations: [], genesisEpubBindings: [] })) });
    console.log("Created primary pilot ledger with absent-only CAS. No app setting changed.");
  } else if (action === "admit-history") {
    const current = await source.load();
    const history = JSON.parse(readFileSync(args[2], "utf8"));
    if (!await source.updateHistory(current.etag, history)) throw Error("Concurrent change; reload and reconcile operator intent");
    console.log("Admitted operator history through shared CAS. Runtime verification still controls access.");
  }
  // Verification opens a new primary snapshot; never calls a successful write
  // or a storage response alone proof of current authority.
  const now = Math.floor(Date.now() / 1000), authority = createForumAuthority(c.authority);
  const result = await authority.refresh(await source.read(now, new AbortController().signal), now);
  if (!result.ok || result.diagnostics.length || authority.graph.ownerOf(c.squad.forumId) !== c.squad.owner) throw Error("Pilot authority verification failed");
  console.log("Primary ledger and signed owner authority verified. Deployment/client acceptance is separate.");
}
main().catch(error => {
  const code = String(error?.code ?? error?.name ?? "Error");
  console.error("Pilot operation failed (" + (/^[A-Za-z0-9_-]{1,64}$/.test(code) ? code : "Error") + "). No secret details emitted.");
  // Local source locations are safe diagnostics; omit the exception message,
  // request/response objects and configuration entirely.
  for (const line of String(error?.stack ?? "").split("\n").slice(1, 4)) if (/^\s+at /.test(line)) console.error(line);
  process.exitCode = 1;
});
