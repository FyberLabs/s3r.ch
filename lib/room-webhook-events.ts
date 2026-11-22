import type { ChatMessage } from "./chat";
import type { RoomChatAdmission } from "./room-chat-admission";
import { admittedRoomTasks, isRoomTaskBody } from "./room-tasks";

type EventBase = Readonly<{ version: 1; id: string; room: string }>;
export type RoomWebhookEvent = EventBase & (
  | Readonly<{
      type: "room.message.created";
      message: { id: string; author: string; text: string; createdAt: number };
    }>
  | Readonly<{
      type: "room.object.created" | "room.object.updated";
      object: { id: string; kind: "task" | "issue"; author: string; changedAt: number };
    }>
);

export function roomMessageWebhookEvent(message: ChatMessage): RoomWebhookEvent {
  return {
    version: 1, type: "room.message.created", id: message.id, room: message.room,
    message: { id: message.id, author: message.author, text: message.body, createdAt: message.ts },
  };
}

/** Project only rows retained by signed chat admission and shared by the room. */
export function projectSharedRoomWebhookEvents(
  room: string, rows: readonly ChatMessage[], admission: RoomChatAdmission,
): RoomWebhookEvent[] {
  const admitted = admission.readable(rows, room);
  const byId = new Map(admitted.map(row => [row.id, row]));
  const messages = [...byId.values()].filter(row => !isRoomTaskBody(row.body)).map(roomMessageWebhookEvent);
  const objects = admittedRoomTasks(admitted, room, admission, admitted.length).flatMap(task => {
    if (task.visibility !== "room") return [];
    return task.events.flatMap(event => {
      const row = byId.get(event.messageId);
      return row ? [{
        version: 1 as const, type: event.name, id: row.id, room,
        object: { id: task.id, kind: task.kind, author: row.author, changedAt: row.ts },
      }] : [];
    });
  });
  return [...messages, ...objects];
}
