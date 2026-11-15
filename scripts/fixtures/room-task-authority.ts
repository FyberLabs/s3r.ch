// CI-only substitution: in-memory authority/session, real SEA signatures.
import { useSyncExternalStore } from "react";
import { createSeaPair, type SeaPair } from "../../lib/identity/sea";
import { createRoomChatAdmission } from "../../lib/room-chat-admission";
import type { ForumAuthorityGraph } from "../../lib/identity/forum-authority";
let pairs: SeaPair[] = [], actor = 0, otherAllowed = false, revision = 0;
const listeners = new Set<()=>void>();
const subscribe = (fn:()=>void) => {listeners.add(fn);return ()=>{listeners.delete(fn);};};
const snapshot = () => revision;
const graph = {
  writerKey: (key:string) => pairs.some(pair=>pair.pub===key) ? key : null,
  principalForKey: (key:string) => pairs.some(pair=>pair.pub===key) ? key : null,
  checkForumSee: (_room:string,key:string) => ({allowed:key===pairs[0]?.pub || (otherAllowed && key===pairs[1]?.pub)}),
  checkPost: (_room:string,key:string) => ({allowed:key===pairs[0]?.pub || (otherAllowed && key===pairs[1]?.pub)}),
} as unknown as ForumAuthorityGraph;
export const admission = createRoomChatAdmission({graph,readerKey:()=>pairs[actor]?.pub ?? null});
const authority = {authority:{graph},admission,pair:()=>pairs[actor] ?? null};
export async function initialize() {
  const saved=sessionStorage.getItem("fixture-task-keys");
  pairs=saved?JSON.parse(saved):[await createSeaPair(),await createSeaPair()];
  sessionStorage.setItem("fixture-task-keys",JSON.stringify(pairs));
}
export const owner = () => pairs[0].pub;
export const other = () => pairs[1].pub;
export function changeActor(next:number) {actor=next; revision++;listeners.forEach(fn=>fn());}
export function grantOther() {otherAllowed=true;revision++;listeners.forEach(fn=>fn());}
export function useRoomAuthority() {useSyncExternalStore(subscribe,snapshot,snapshot);return {current:authority,revision};}
export function useIdentitySession() {useSyncExternalStore(subscribe,snapshot,snapshot);return {owner:pairs[actor]?.pub};}
