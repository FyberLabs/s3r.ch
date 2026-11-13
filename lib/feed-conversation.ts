import type {FeedItem,FeedSource} from "./feed-types";
import type {FeedReference} from "./feed-reply";
export const CONVERSATION_DEPTH=8,CONVERSATION_REPLIES=16;
export type FeedConversation={items:FeedItem[];replies:FeedItem[];missingParent:FeedReference|null;truncated:boolean};
export function cachedConversation(rows:readonly FeedItem[],source:FeedSource,id:string):FeedConversation|null {
 const map=new Map(rows.filter(item=>item.source===source).map(item=>[item.id,item]));
 const current=map.get(id);if(!current)return null;
 const chain=[current],seen=new Set([current.id]);let missingParent:FeedReference|null=null,truncated=false;
 let cursor=current;
 while(cursor.replyTo){
  if(chain.length>CONVERSATION_DEPTH || seen.has(cursor.replyTo.id)){truncated=true;break;}
  const parent=map.get(cursor.replyTo.id);if(!parent){missingParent=cursor.replyTo;break;}
  seen.add(parent.id);chain.push(parent);cursor=parent;
 }
 const direct=rows.filter(item=>item.source===source && item.id!==id && item.replyTo?.id===id)
  .sort((a,b)=>a.ts-b.ts||a.id.localeCompare(b.id));
 const bounded=(item:FeedItem)=>({...item,body:item.body.slice(0,4000),author:item.author.slice(0,256)});
 return {items:chain.reverse().map(bounded),replies:direct.slice(0,CONVERSATION_REPLIES).map(bounded),missingParent,
  truncated:truncated||direct.length>CONVERSATION_REPLIES};
}
