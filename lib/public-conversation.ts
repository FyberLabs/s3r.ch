import {cachedConversation} from "./feed-conversation";
import type {FeedItem,FeedSource} from "./feed-types";
import {fetchAtprotoConversation} from "./atproto-conversation";
/** Small transient public-response cache; durable product storage remains tenant-owned. */
export function createPublicConversations(pull=fetchAtprotoConversation,clock=Date.now){
 type Entry={until:number;rows:FeedItem[];truncated:boolean};
 const cache=new Map<string,Entry>(),pending=new Map<string,Promise<Entry>>();
 return async(rows:readonly FeedItem[],source:FeedSource,id:string)=>{
  const anchor=rows.find(row=>row.source===source&&row.id===id);if(!anchor)return null;
  if(source!=="atproto")return cachedConversation(rows,source,id);
  const key=JSON.stringify([source,id,anchor.replyTo?.id,anchor.root?.id]);
  let entry=cache.get(key);
  if(!entry||entry.until<=clock()){
   let work=pending.get(key);
   if(!work&&pending.size<4){
    work=Promise.resolve().then(()=>pull(anchor)).then(result=>({until:clock()+60_000,rows:result.rows,truncated:result.truncated}),()=>({until:clock()+15_000,rows:[],truncated:false}));
    pending.set(key,work);
    void work.then(result=>{cache.delete(key);cache.set(key,result);while(cache.size>64)cache.delete(cache.keys().next().value!);}).finally(()=>pending.delete(key));
   }
   if(!work)return cachedConversation(rows,source,id);
   entry=await work;
  }
  const combined=new Map(rows.map(row=>[`${row.source}\0${row.id}`,row]));
  for(const row of entry.rows)if(row.source===source&&row.id!==id)combined.set(`${row.source}\0${row.id}`,row);
  const result=cachedConversation([...combined.values()],source,id);
  return result?{...result,truncated:result.truncated||entry.truncated}:null;
 };
}
export const publicConversations=createPublicConversations();
