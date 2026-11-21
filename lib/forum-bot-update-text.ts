import { isSeaPubkey } from "./identity/forum-check";
import { encodeBotMessage, type BotMessage } from "./forum-bot-protocol";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NESTED_VISOR = /visor:v[12]:/i;
const APPROVAL_SHAPE = /"(?:artifactReaders|principal|handle)"\s*:|"steps"\s*:\s*\[/;
const TOOL_ARRAY = /\[\s*"(?:task|approval|progress|result|ack|cancel|update)"/;
const PEM_BLOCK = /-----BEGIN/;
const PRIVATE_FIELD = /"(?:priv|epriv)"\s*:/;
const CREDENTIAL_URL = /:\/\/[^/\s]+:[^@\s/]+@/;

/** Bound free-text task notes; refuse nested bot commands and private grant material. */
export function validateBotUpdateText(text: unknown, bind: Readonly<{ tenant: string; task: string; handles?: readonly string[] }>): string {
  if (typeof text !== "string" || text.length === 0) throw Error("Invalid bot update");
  if (!uuid.test(bind.tenant) || !uuid.test(bind.task)) throw Error("Invalid bot update binding");
  const trimmed = text.trim();
  if (!trimmed || trimmed.length !== text.length || trimmed.length > 180) throw Error("Invalid bot update");
  if (uuid.test(trimmed)) throw Error("Invalid bot update");
  if (NESTED_VISOR.test(trimmed) || APPROVAL_SHAPE.test(trimmed) || TOOL_ARRAY.test(trimmed) ||
      PEM_BLOCK.test(trimmed) || PRIVATE_FIELD.test(trimmed) || CREDENTIAL_URL.test(trimmed))
    throw Error("Invalid bot update");
  for (const handle of bind.handles ?? []) {
    if (handle === trimmed || trimmed.includes(handle)) throw Error("Invalid bot update");
  }
  for (const segment of trimmed.split(/[^A-Za-z0-9_-]+/)) if (segment.length > 40 && isSeaPubkey(segment)) throw Error("Invalid bot update");
  const message: BotMessage = ["update", bind.tenant, bind.task, trimmed];
  encodeBotMessage(message);
  return trimmed;
}