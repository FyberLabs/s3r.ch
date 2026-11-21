import { isSeaPubkey } from "./identity/forum-check";
import { encodeBotMessage, type BotMessage } from "./forum-bot-protocol";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NESTED_VISOR = /visor:v[12]:/i;
const APPROVAL_SHAPE = /"(?:artifactReaders|principal|handle)"\s*:|"steps"\s*:\s*\[/;
const TOOL_ARRAY = /\[\s*"(?:task|approval|progress|result|ack|cancel|update)"/;
const PEM_BLOCK = /-----BEGIN/;
const PRIVATE_FIELD = /"(?:priv|epriv)"\s*:/;
function containsCredentialUrl(value: string): boolean {
  return value.split("://").slice(1).some(rest => {
    const authority = rest.split(/[\s/?#]/, 1)[0];
    const userInfoEnd = authority.indexOf("@");
    const colon = authority.indexOf(":");
    return colon > 0 && userInfoEnd > colon + 1;
  });
}

/** Bound free-text task notes; refuse nested bot commands and private grant material. */
export function validateBotUpdateText(text: unknown, bind: Readonly<{ tenant: string; task: string; handles?: readonly string[] }>): string {
  if (typeof text !== "string" || text.length === 0) throw Error("Invalid bot update");
  if (!uuid.test(bind.tenant) || !uuid.test(bind.task)) throw Error("Invalid bot update binding");
  const trimmed = text.trim();
  if (!trimmed || trimmed.length !== text.length || trimmed.length > 180) throw Error("Invalid bot update");
  if (uuid.test(trimmed)) throw Error("Invalid bot update");
  if (NESTED_VISOR.test(trimmed) || APPROVAL_SHAPE.test(trimmed) || TOOL_ARRAY.test(trimmed) ||
      PEM_BLOCK.test(trimmed) || PRIVATE_FIELD.test(trimmed) || containsCredentialUrl(trimmed))
    throw Error("Invalid bot update");
  for (const handle of bind.handles ?? []) {
    if (handle === trimmed || trimmed.includes(handle)) throw Error("Invalid bot update");
  }
  for (const key of trimmed.match(/[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}/g) ?? []) {
    if (isSeaPubkey(key)) throw Error("Invalid bot update");
  }
  const message: BotMessage = ["update", bind.tenant, bind.task, trimmed];
  encodeBotMessage(message);
  return trimmed;
}
