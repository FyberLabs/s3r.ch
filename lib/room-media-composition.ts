import type { RoomChatAdmission } from "./room-chat-admission";
import type { SeaPair } from "./identity/sea";
import { parseRoomMedia } from "./room-media";

/** Async signing may outlive a room, identity or composer. Never publish late. */
export async function composeCurrentRoomMedia(input:{room:string;body:string;admission:RoomChatAdmission;
  pair:()=>SeaPair|null;current:()=>boolean}) {
  if(!input.current() || !parseRoomMedia(input.body))return null;
  const next=await input.admission.compose(input.room,input.body,input.pair);
  return input.current() && next && input.admission.valid(next) ? next : null;
}
