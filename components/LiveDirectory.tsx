"use client";
import {useEffect,useState} from "react";
import {PublicFeedVideo} from "./PublicFeedVideo";
import type {PublicLiveStream} from "@/lib/nostr-live";
export function LiveDirectory(){
 const [streams,setStreams]=useState<PublicLiveStream[]>([]),[available,setAvailable]=useState<boolean|null>(null),[now,setNow]=useState(0),[selected,setSelected]=useState<string|null>(null),[failed,setFailed]=useState(false);
 useEffect(()=>{
  let stopped=false,generation=0,controller:AbortController|null=null;
  const update=async()=>{const held=++generation;controller?.abort();controller=new AbortController();
   try {const response=await fetch("/api/live",{signal:controller.signal,cache:"no-store"});if(!response.ok)throw Error();
    const result=await response.json();if(stopped||held!==generation)return;
    if(!Array.isArray(result.streams)||result.streams.length>100)throw Error();
    setStreams(result.streams);setAvailable(result.available);setNow(Math.floor(Date.now()/1000));
   }catch{if(!stopped&&held===generation)setAvailable(false);}
  };
  void update();const refresh=setInterval(()=>void update(),60_000),tick=setInterval(()=>setNow(Math.floor(Date.now()/1000)),1000);
  return()=>{stopped=true;controller?.abort();clearInterval(refresh);clearInterval(tick);};
 },[]);
 const visible=streams.filter(stream=>stream.expires>now);
 return <section className="space-y-4" aria-label="Live streams">
  <p>Public Nostr streams from the accounts this site follows. Room streams are coming in v1.</p>
  <p className="text-sm text-ink-muted">Live status expires after one hour without an update. Participant counts are reported by the publisher.</p>
  {available===null?<p role="status">Checking for live streams…</p>:available===false?<p role="status">The live source is unavailable. Previously received entries expire normally.</p>:null}
  {available!==null&&!visible.length?<p>No live streams from these accounts right now.</p>:null}
  <ul className="space-y-6">{visible.map(stream=><li key={stream.id} className="border border-rule p-4">
   <h2 className="font-semibold">{stream.title}</h2><p className="break-all text-sm">Publisher: {stream.author}</p>
   <p>Live for {Math.max(0,Math.floor((now-stream.starts)/60))} minutes{stream.participants!==undefined?` · ${stream.participants} participants`:""}</p>
   {stream.thumbnail?<img alt="" loading="lazy" className="max-h-48" src={`/api/feed/media?${new URLSearchParams({url:stream.thumbnail,kind:"image"})}`}/>:null}
   {selected===stream.id?<><PublicFeedVideo key={stream.url} url={stream.url} onError={()=>setFailed(true)}/>{failed?<p role="status">This stream could not play.</p>:null}<button type="button" onClick={()=>setSelected(null)}>Close player</button></>:<button type="button" onClick={()=>{setSelected(stream.id);setFailed(false);}}>Watch stream</button>}
  </li>)}</ul>
 </section>;
}
