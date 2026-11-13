"use client";
import {useEffect,useRef,useState} from "react";
import {fromGunNode,type FeedItem} from "@/lib/feed-types";
import {parseFeedReference} from "@/lib/feed-reply";
import {publicMediaUrl} from "@/lib/feed-media";
import type {FeedConversation as Conversation} from "@/lib/feed-conversation";
import PublicFeedMedia from "./PublicFeedMedia";
export function ConversationView({conversation}:{conversation:Conversation}){
 const card=(item:FeedItem)=><article key={item.id} className="my-2 border border-rule p-3"><p className="text-xs">{item.author}</p><p>{item.body}</p><PublicFeedMedia media={item.media}/>{publicMediaUrl(item.permalink)?<a href={item.permalink} target="_blank" rel="noopener noreferrer">Original</a>:null}</article>;
 return <div>{conversation.missingParent?<p>Post unavailable</p>:null}{conversation.items.map(card)}{conversation.replies.length?<p>Direct replies</p>:null}{conversation.replies.map(card)}{conversation.truncated?<p>Conversation limit reached.</p>:null}</div>;
}
export default function FeedConversation({item}:{item:FeedItem}){
 const [open,setOpen]=useState(false),[conversation,setConversation]=useState<Conversation|null>(null),[error,setError]=useState(false);
 const controller=useRef<AbortController|null>(null);
 useEffect(()=>()=>controller.current?.abort(),[item.id,item.source]);
 const parent=parseFeedReference(item.replyTo);if(!parent)return null;
 async function toggle(){
  if(open){controller.current?.abort();setOpen(false);return;}setOpen(true);setError(false);setConversation(null);
  const current=new AbortController();controller.current?.abort();controller.current=current;
  try{
   const response=await fetch(`/api/feed/conversation?${new URLSearchParams({source:item.source,id:item.id})}`,{signal:current.signal,credentials:"omit"});
   if(!response.ok)throw Error();const reader=response.body?.getReader();if(!reader)throw Error();
   const buffer=new Uint8Array(512*1024);let used=0;
   try{while(true){const {done,value}=await reader.read();if(done)break;if(value.length>buffer.length-used)throw Error();buffer.set(value,used);used+=value.length;}}
   finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
   const value=JSON.parse(new TextDecoder().decode(buffer.subarray(0,used)));
   if(!Array.isArray(value.items)||value.items.length>9||!Array.isArray(value.replies)||value.replies.length>16)throw Error();
   const items=value.items.map(fromGunNode),replies=value.replies.map(fromGunNode);
   if([...items,...replies].some(entry=>!entry||entry.source!==item.source))throw Error();
   if(!current.signal.aborted)setConversation({items,replies,missingParent:parseFeedReference(value.missingParent),truncated:value.truncated===true});
  }catch{if(!current.signal.aborted)setError(true);}
 }
 return <div className="my-2 text-sm"><a href={parent.permalink} target="_blank" rel="noopener noreferrer">Replying to {parent.author?`@${parent.author}`:"a post"}</a><button type="button" className="ml-3" aria-expanded={open} onClick={()=>void toggle()}>{open?"Hide conversation":"Show conversation"}</button>{open?(error?<p>Post unavailable</p>:conversation?<ConversationView conversation={conversation}/>:<p>Loading conversation…</p>):null}</div>;
}
