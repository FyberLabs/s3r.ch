/** Private artifact bytes never enter forum posts. Access requires a fresh SEA
 * proof, current thread membership, and the owner's still-current local grant.
 */
import { randomUUID } from "node:crypto";
import { openSync, closeSync, lstatSync, unlinkSync, writeFileSync, fsyncSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { BotInboxScope } from "./forum-bot-inbox";
import type { ForumAuthorityGraph } from "./identity/forum-authority";
import { readForumSignature } from "./forum-sign";
import { isSeaPubkey } from "./identity/forum-check";
import { privateBotDirectory, readPrivateBotFile, type LocalBotApproval } from "./forum-bot-local-access";
const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
export function openForumBotArtifacts(input: { directory: string; scope: BotInboxScope; authority: ForumAuthorityGraph;
  approval(handle: string): LocalBotApproval | null; clock?: () => number }) {
  const directory = input.directory, scope = Object.freeze({ ...input.scope }), { authority, approval } = input;
  const clock = input.clock ?? (() => Math.floor(Date.now() / 1000));
  privateBotDirectory(directory);
  const used = new Map<string, number>();
  const currentGrant = (handle: string, at: number) => {
    const grant = approval(handle);
    return grant && grant.handle === handle && grant.tenant === scope.tenant && grant.forum === scope.forum &&
      grant.bot === scope.bot && grant.principal === scope.principal && grant.revoked === false && grant.expires > at ? grant : null;
  };
  return Object.freeze({
    put(handle: string, task: string, mime: "image/png" | "application/json", bytes: Uint8Array): string {
      const now = clock(), grant = currentGrant(handle, now);
      if (!grant || !uuid(task) || !["image/png", "application/json"].includes(mime) ||
          !bytes.length || bytes.length > 1048576 || grant.expires <= now || !grant.artifactReaders.length)
        throw Error("Artifact storage not authorized");
      privateBotDirectory(directory);
      if (readdirSync(directory).filter(name => name.endsWith(".json")).length >= 256) throw Error("Artifact capacity reached");
      const id = randomUUID(), path = join(directory, id + ".json");
      const encoded = JSON.stringify({ version: 1, ...scope, id, task, handle, mime, expires: grant.expires,
        readers: grant.artifactReaders, data: Buffer.from(bytes).toString("base64") });
      const fd = openSync(path, "wx", 0o600);
      try { writeFileSync(fd, encoded); fsyncSync(fd); } catch (error) { closeSync(fd); unlinkSync(path); throw error; }
      closeSync(fd);
      const parent = openSync(directory, "r"); try { fsyncSync(parent); } finally { closeSync(parent); }
      return id;
    },
    async read(request: { principal: string; issuedAt: number; signature: string }) {
      const row = Object.freeze({ ...request }), at = clock();
      if (!isSeaPubkey(row.principal) || !Number.isSafeInteger(row.issuedAt) || row.issuedAt > at || at - row.issuedAt > 30 ||
          typeof row.signature !== "string" || row.signature.length > 16384) throw Error("Artifact access denied");
      const key = authority.writerKey(row.principal, row.issuedAt, at);
      if (!key) throw Error("Artifact access denied");
      const proof = await readForumSignature(row.signature, key) as any;
      if (!proof || Object.keys(proof).sort().join() !== "artifact,bot,forum,issuedAt,nonce,operation,tenant,version" ||
          proof.version !== 1 || proof.operation !== "read-artifact" || proof.tenant !== scope.tenant || proof.forum !== scope.forum ||
          proof.bot !== scope.bot || proof.issuedAt !== row.issuedAt || !uuid(proof.artifact) || !uuid(proof.nonce))
        throw Error("Artifact access denied");
      const now = clock();
      for (const [nonce, expires] of used) if (expires < now) used.delete(nonce);
      const nonce = row.principal + ":" + proof.nonce;
      if (used.has(nonce) || used.size >= 4096) throw Error("Artifact proof already used or capacity reached");
      privateBotDirectory(directory);
      const artifact = JSON.parse(readPrivateBotFile(join(directory, proof.artifact + ".json"), 1500000).toString("utf8"));
      const granted = () => {
        const t = clock(), grant = currentGrant(artifact.handle, t);
        return !!grant && Number.isSafeInteger(t) && t >= row.issuedAt && t - row.issuedAt <= 30 && artifact.expires > t &&
          artifact.version === 1 && artifact.id === proof.artifact && artifact.tenant === scope.tenant && artifact.forum === scope.forum &&
          artifact.bot === scope.bot && artifact.principal === scope.principal && uuid(artifact.task) &&
          grant.artifactReaders.includes(row.principal) && Array.isArray(artifact.readers) && artifact.readers.includes(row.principal) &&
          authority.writerKey(row.principal, row.issuedAt, t) === key &&
          authority.checkForumSee(scope.forum, row.principal, t).allowed === true &&
          authority.checkForumSee(scope.forum, scope.principal, t).allowed === true;
      };
      if (!granted() || !["image/png", "application/json"].includes(artifact.mime) || typeof artifact.data !== "string")
        throw Error("Artifact access denied");
      const bytes = Buffer.from(artifact.data, "base64");
      if (!bytes.length || bytes.length > 1048576 || bytes.toString("base64") !== artifact.data || !granted())
        throw Error("Artifact access denied");
      used.set(nonce, row.issuedAt + 30);
      return Object.freeze({ mime: artifact.mime as string, bytes });
    },
    revoke(id: string) {
      if (!uuid(id)) throw Error("Invalid artifact reference");
      const path = join(directory, id + ".json");
      privateBotDirectory(directory); const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid!()) throw Error("Invalid private artifact");
      unlinkSync(path);
    },
  });
}
