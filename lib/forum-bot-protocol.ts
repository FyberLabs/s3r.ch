/** Bot messages occupy ordinary signed forum statements. Handles reference
 * separately authorized tasks/artifacts; a message never contains tool input.
 */
export const BOT_MESSAGE_PREFIX = "visor:v1:";
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
export type BotTaskMessage = readonly ["task", tenant: string, task: string, recipient: string, handle: string, expires: number, parent: string | null, depth: number];
export type BotMessage = BotTaskMessage |
  readonly ["approval", tenant: string, task: string, approvedAt: number, expires: number] |
  readonly ["ack" | "cancel", tenant: string, task: string] |
  readonly ["progress", tenant: string, task: string, percent: number] |
  readonly ["result", tenant: string, task: string, state: "completed" | "failed" | "cancelled", artifact: string | null];
export function parseBotMessage(body: unknown): BotMessage | null {
  if (typeof body !== "string" || body.length > 280 || !body.startsWith(BOT_MESSAGE_PREFIX)) return null;
  try {
    const row: unknown = JSON.parse(body.slice(BOT_MESSAGE_PREFIX.length));
    if (!Array.isArray(row) || !uuid(row[1]) || !uuid(row[2])) return null;
    if (row.length === 8 && row[0] === "task" && uuid(row[3]) && uuid(row[4]) &&
        Number.isSafeInteger(row[5]) && row[5] > 0 && (row[6] === null || uuid(row[6])) &&
        Number.isInteger(row[7]) && row[7] >= 0 && row[7] <= 4) return Object.freeze(row) as BotTaskMessage;
    if (row.length === 3 && (row[0] === "ack" || row[0] === "cancel")) return Object.freeze(row) as BotMessage;
    if (row.length === 5 && row[0] === "approval" && Number.isSafeInteger(row[3]) && row[3] > 0 &&
        Number.isSafeInteger(row[4]) && row[4] > row[3])
      return Object.freeze(row) as BotMessage;
    if (row.length === 4 && row[0] === "progress" && Number.isInteger(row[3]) && row[3] >= 0 && row[3] <= 100)
      return Object.freeze(row) as BotMessage;
    if (row.length === 5 && row[0] === "result" && ["completed", "failed", "cancelled"].includes(row[3]) &&
        (row[4] === null || uuid(row[4]))) return Object.freeze(row) as BotMessage;
  } catch { /* Malformed or future formats carry no bot command. */ }
  return null;
}
export function encodeBotMessage(message: BotMessage): string {
  const body = BOT_MESSAGE_PREFIX + JSON.stringify(message);
  if (!parseBotMessage(body)) throw Error("Invalid bot message");
  return body;
}
