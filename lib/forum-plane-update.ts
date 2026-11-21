import { parseBotMessage } from "./forum-bot-protocol";
import { validateBotUpdateText } from "./forum-bot-update-text";
import { forumStatementFromNode } from "./forum-squad";
import { readForumSignature } from "./forum-sign";

export type ForumUpdateProof = Readonly<{
  botId: string;
  assignmentId: string;
  sessionId: string;
  taskId: string;
  deliveryId: string;
  sequence: number;
  signature: string;
}>;
export type VerifiedForumUpdate = ForumUpdateProof & Readonly<{
  forumId: string;
  statementId: string;
  tenant: string;
  principal: string;
}>;

const uuid = (value: unknown): value is string => typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) &&
  value !== "00000000-0000-0000-0000-000000000000";

export function parseForumUpdateProof(value: unknown): ForumUpdateProof | null {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort((left, right) => left.localeCompare(right, "en")).join() !== "assignmentId,botId,deliveryId,sequence,sessionId,signature,taskId") return null;
  const proof = value as Record<string, unknown>;
  if (!uuid(proof.botId) || !uuid(proof.assignmentId) || !uuid(proof.sessionId) ||
      !uuid(proof.taskId) || !uuid(proof.deliveryId) || typeof proof.sequence !== "number" ||
      !Number.isSafeInteger(proof.sequence) || proof.sequence < 1 || typeof proof.signature !== "string" ||
      proof.signature.length > 32768) return null;
  return { botId: proof.botId, assignmentId: proof.assignmentId, sessionId: proof.sessionId,
    taskId: proof.taskId, deliveryId: proof.deliveryId, sequence: proof.sequence, signature: proof.signature };
}

export async function verifyForumUpdate(proof: ForumUpdateProof, scope: {
  tenant: string; forumId: string; principal: string; object: string; issuedAt: number; writerKey: string;
}): Promise<VerifiedForumUpdate | null> {
  const signed = await readForumSignature(proof.signature, scope.writerKey);
  const item = forumStatementFromNode(signed, scope.forumId);
  if (!item || item.kind !== "statement" || item.id !== scope.object || item.ts !== scope.issuedAt ||
      item.author !== scope.principal) return null;
  const message = parseBotMessage(item.body);
  if (!message || message[0] !== "update" || message[1] !== scope.tenant || message[2] !== proof.taskId) return null;
  try { validateBotUpdateText(message[3], { tenant: scope.tenant, task: proof.taskId }); }
  catch { return null; }
  return { ...proof, tenant: scope.tenant, forumId: scope.forumId, statementId: scope.object, principal: scope.principal };
}
