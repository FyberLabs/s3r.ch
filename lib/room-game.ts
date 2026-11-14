/** Small room games are projections of admitted chat objects, not a new store.
 * Callers must apply the same room/message Check used by chat before projecting.
 * Presence is display-only; a heartbeat never selects a player or grants access. */
import { checkSee, roomSoul, type SeeAcl } from "./identity/check";
import { signedRoomMessageId, type RoomChatAdmission } from "./room-chat-admission";
import { isSeaPubkey } from "./identity/forum-check";
import { getAddress } from "viem";
import { composeChat, shortChatEntropy, type ChatMessage } from "./chat";

const PREFIX = "s3rch-game:v1:";
type Start = readonly ["start"];
type Join = readonly ["join", string, string];
type Move = readonly ["move", string, string, number];
export type RoomGameAction = Start | Join | Move;
export type RoomGame = Readonly<{
  id: string; room: string; x: string; o: string | null; head: string;
  board: readonly ("X" | "O" | null)[]; turn: "X" | "O";
  outcome: "X" | "O" | "draw" | null; startedAt: number;
}>;
const idOK = (value: unknown): value is string => typeof value === "string" &&
  (signedRoomMessageId(value) || /^s3rch:chat:(?:0x[0-9a-fA-F]{40}|[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}):[0-9]{1,16}:[A-Za-z0-9_-]{1,32}$/.test(value));
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export function canPlayRoomGame(acl: SeeAcl, room: string, actor: string, now: number): boolean {
  return checkSee(acl, roomSoul(room), actor, now).allowed;
}

export function parseRoomGameAction(body: unknown): RoomGameAction | null {
  if (typeof body !== "string" || body.length > 512 || !body.startsWith(PREFIX)) return null;
  try {
    const value: unknown = JSON.parse(body.slice(PREFIX.length));
    if (!Array.isArray(value)) return null;
    if (value.length === 1 && value[0] === "start") return ["start"];
    if (!idOK(value[1]) || !idOK(value[2])) return null;
    if (value.length === 3 && value[0] === "join") return ["join", value[1], value[2]];
    if (value.length === 4 && value[0] === "move" && Number.isInteger(value[3]) && value[3] >= 0 && value[3] <= 8)
      return ["move", value[1], value[2], value[3]];
  } catch { /* Ordinary chat, including unknown game versions, stays text. */ }
  return null;
}

export function composeRoomGame(room: string, author: string, action: RoomGameAction, nowSeconds?: number): ChatMessage | null {
  const body = PREFIX + JSON.stringify(action);
  if (!parseRoomGameAction(body)) return null;
  return composeChat({ roomId: room, address: author, body, nowSeconds, entropy: shortChatEntropy(16) });
}

export function roomGameChatText(body: string): string {
  const action = parseRoomGameAction(body);
  if (!action) return body;
  return action[0] === "start" ? "Started a tic-tac-toe game." : action[0] === "join" ?
    "Joined a tic-tac-toe game." : `Tic-tac-toe move: square ${action[3] + 1}.`;
}

function outcome(board: RoomGame["board"]): RoomGame["outcome"] {
  for (const [a, b, c] of [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]])
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
  return board.every(Boolean) ? "draw" : null;
}

/** An explicit predecessor binds every join/move to the board the player saw.
 * Concurrent siblings use bytewise message-ID order, independent of arrival.
 * Missing parents wait; stale moves, outsiders and moves after a result are ignored. */
export function roomGames(messages: readonly ChatMessage[], room: string): RoomGame[] {
  return projectRoomGames(messages, room, false);
}

/** Compact IDs only enter through current signature admission. */
export function admittedRoomGames(messages: readonly ChatMessage[], room: string, admission: RoomChatAdmission): RoomGame[] {
  return projectRoomGames(admission.readable(messages, room), room, true);
}

function projectRoomGames(messages: readonly ChatMessage[], room: string, signed: boolean): RoomGame[] {
  if (messages.length > 8192) return [];
  const rows = new Map<string, { message: ChatMessage; action: RoomGameAction }>();
  const conflicts = new Set<string>();
  for (const message of messages) {
    if (message.room !== room || !idOK(message.id) || !Number.isSafeInteger(message.ts) || message.ts < 0 || (message.v !== undefined && message.v !== 1)) continue;
    let author: string;
    try { author = isSeaPubkey(message.author) ? message.author : getAddress(message.author); } catch { continue; }
    if (signed ? !signedRoomMessageId(message.id) : !message.id.startsWith(`s3rch:chat:${author}:`)) continue;
    const action = parseRoomGameAction(message.body);
    if (!action) continue;
    const normalized = { ...message, author };
    const old = rows.get(message.id);
    if (old && JSON.stringify([old.message.body, old.message.ts]) !== JSON.stringify([message.body, message.ts])) conflicts.add(message.id);
    else rows.set(message.id, { message: normalized, action });
  }
  for (const id of conflicts) rows.delete(id);
  const children = new Map<string, typeof rows extends Map<string, infer T> ? T[] : never>();
  for (const row of rows.values()) if (row.action[0] !== "start") {
    const key = JSON.stringify([row.action[1], row.action[2]]);
    const held = children.get(key) ?? []; held.push(row); children.set(key, held);
  }
  for (const held of children.values()) held.sort((a,b) => order(a.message.id,b.message.id));
  return [...rows.values()].filter(row => row.action[0] === "start")
    .sort((a,b) => b.message.ts - a.message.ts || order(a.message.id,b.message.id)).slice(0,8).map(({message}) => {
      const game = { id: message.id, room, x: message.author, o: null as string | null, head: message.id,
        board: Array<"X" | "O" | null>(9).fill(null), turn: "X" as "X" | "O", outcome: null as RoomGame["outcome"], startedAt: message.ts };
      for (let step = 0; step < 10 && !game.outcome; step++) {
        const next = children.get(JSON.stringify([game.id,game.head]))?.find(({message: child,action}) =>
          !game.o ? action[0] === "join" && child.author !== game.x :
            action[0] === "move" && child.author === (game.turn === "X" ? game.x : game.o) && game.board[action[3]] === null);
        if (!next) break;
        if (next.action[0] === "join") game.o = next.message.author;
        else if (next.action[0] === "move") {
          game.board[next.action[3]] = game.turn;
          game.outcome = outcome(game.board);
          game.turn = game.turn === "X" ? "O" : "X";
        }
        game.head = next.message.id;
      }
      return game;
    });
}
