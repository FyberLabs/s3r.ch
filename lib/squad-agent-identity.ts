import { writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { privateBotDirectory, readPrivateBotFile } from "./forum-bot-local-access";
import { signForumRecord } from "./forum-sign";
import { readBoundedIdentityJson } from "./identity/bounded-json";
import { isSeaPubkey } from "./identity/forum-check";
import { createSeaPair, isSeaPair } from "./identity/sea";
import { SQUAD_AGENT_SCOPE } from "./squad-agent-enrollment";

export async function generateSquadAgentKey(path: string) {
  privateBotDirectory(dirname(path));
  const pair = await createSeaPair();
  writeFileSync(path, JSON.stringify(pair), { flag: "wx", mode: 0o600, flush: true });
  return pair.pub;
}

export function openSquadAgentIdentity(path: string, send: typeof fetch = fetch) {
  privateBotDirectory(dirname(path));
  const config = JSON.parse(readPrivateBotFile(path, 4096).toString("utf8"));
  if (!config || Object.keys(config).sort().join() !== "delegationId,origin,pairFile,version" ||
      config.version !== 1 || typeof config.delegationId !== "string" || !/^[a-f0-9]{64}$/.test(config.delegationId) ||
      typeof config.origin !== "string" || !config.origin.startsWith("https://") || new URL(config.origin).origin !== config.origin ||
      typeof config.pairFile !== "string" || !isAbsolute(config.pairFile))
    throw Error("Invalid native Squad identity configuration");
  privateBotDirectory(dirname(config.pairFile));
  const pair = JSON.parse(readPrivateBotFile(config.pairFile, 4096).toString("utf8"));
  if (!isSeaPair(pair) || !isSeaPubkey(pair.pub) || !isSeaPubkey(pair.epub)) throw Error("Invalid native Squad key");
  const { origin, delegationId } = config as { origin: string; delegationId: string };
  return Object.freeze({
    origin,
    principal: pair.pub,
    async session(parent?: AbortSignal) {
      const deadline = AbortSignal.timeout(12_000);
      const signal = parent ? AbortSignal.any([parent, deadline]) : deadline;
      async function post(action: "challenge" | "exchange", body: object) {
        const response = await send(origin + "/api/identity/agent/" + action, {
          method: "POST", redirect: "error", credentials: "omit", cache: "no-store", signal,
          headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw Error("Squad agent session refused");
        }
        return await readBoundedIdentityJson(response, 12_288, signal);
      }
      const challenge = await post("challenge", { delegationId, scopes: [SQUAD_AGENT_SCOPE] });
      if (!challenge || typeof challenge !== "object" || !("challenge" in challenge) ||
          typeof challenge.challenge !== "string" || !/^[A-Za-z0-9_.-]{1,8192}$/.test(challenge.challenge))
        throw Error("Invalid Squad agent challenge");
      const signature = await signForumRecord(challenge.challenge, pair);
      if (!signature) throw Error("Could not sign Squad agent challenge");
      const session = await post("exchange", { challenge: challenge.challenge, signature });
      if (!session || typeof session !== "object" || !("tokenType" in session) || session.tokenType !== "Bearer" || !("token" in session) ||
          typeof session.token !== "string" || !/^[A-Za-z0-9_.-]{1,8192}$/.test(session.token))
        throw Error("Invalid Squad agent session response");
      return session.token;
    },
  });
}
