import { parseBotMessage } from "./forum-bot-protocol";
import { validateBotUpdateText } from "./forum-bot-update-text";
import { forumStatementFromNode } from "./forum-squad";
import { verifyForumKeySignature } from "./identity/forum-key-signature";
import { readForumSignature } from "./forum-sign";

export type ForumUpdateProof = Readonly<{
  botId: string;
  assignmentId: string;
  sessionId: string;
  taskId: string;
  deliveryId: string;
  sequence: number;
  signature: string;
  attestation: string;
}>;
export const VISOR_FORUM_STATUS_TEXT = {
  completed: "Conductor completed the task.",
  failed: "Conductor reported that the task failed.",
} as const;

export type VerifiedForumUpdate = ForumUpdateProof & Readonly<{
  forumId: string;
  statementId: string;
  tenant: string;
  principal: string;
  status: keyof typeof VISOR_FORUM_STATUS_TEXT;
}>;

const uuid = (value: unknown): value is string => typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) &&
  value !== "00000000-0000-0000-0000-000000000000";

export function parseForumUpdateProof(value: unknown): ForumUpdateProof | null {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort((left, right) => left.localeCompare(right, "en")).join() !== "assignmentId,attestation,botId,deliveryId,sequence,sessionId,signature,taskId") return null;
  const proof = value as Record<string, unknown>;
  if (!uuid(proof.botId) || !uuid(proof.assignmentId) || !uuid(proof.sessionId) ||
      !uuid(proof.taskId) || !uuid(proof.deliveryId) || typeof proof.sequence !== "number" ||
      !Number.isSafeInteger(proof.sequence) || proof.sequence < 1 || typeof proof.signature !== "string" ||
      proof.signature.length > 32768 || typeof proof.attestation !== "string" ||
      !/^[A-Za-z0-9_-]{86}$/.test(proof.attestation)) return null;
  return { botId: proof.botId, assignmentId: proof.assignmentId, sessionId: proof.sessionId,
    taskId: proof.taskId, deliveryId: proof.deliveryId, sequence: proof.sequence, signature: proof.signature, attestation: proof.attestation };
}

export function forumUpdateTranscript(update: Omit<VerifiedForumUpdate, "attestation">): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(["s3rch-forum-update-v1", update.tenant,
    update.forumId, update.principal, update.botId, update.assignmentId, update.sessionId,
    update.taskId, update.deliveryId, update.sequence, update.statementId, update.status, update.signature]));
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
  const status = message[3] === VISOR_FORUM_STATUS_TEXT.completed ? "completed"
    : message[3] === VISOR_FORUM_STATUS_TEXT.failed ? "failed" : null;
  if (!status) return null;
  const update = { ...proof, tenant: scope.tenant, forumId: scope.forumId, statementId: scope.object,
    principal: scope.principal, status } as const;
  return verifyForumKeySignature(scope.writerKey, proof.attestation, forumUpdateTranscript(update)) ? update : null;
}
