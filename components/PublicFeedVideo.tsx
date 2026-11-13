"use client";
import {useEffect,useRef} from "react";
import type Hls from "hls.js";
export function PublicFeedVideo({url,poster,onError}:{url:string;poster?:string;onError:()=>void}) {
  const video=useRef<HTMLVideoElement>(null), player=useRef<Hls|null>(null);
  const failure=useRef(onError);failure.current=onError;
  const playlist=/\.m3u8(?:$|[?#])/i.test(url);
  const source=`/api/feed/media?${new URLSearchParams({url,kind:"video"})}`;
  useEffect(()=>{
    const element=video.current;if(!element || !playlist)return;
    let disposed=false;
    if(element.canPlayType("application/vnd.apple.mpegurl")){element.src=source;return ()=>{element.removeAttribute("src");element.load();};}
    void import("hls.js").then(({default:Hls})=>{
      if(disposed)return;
      if(!Hls.isSupported()){failure.current();return;}
      const hls=new Hls({enableWorker:false,autoStartLoad:false,maxBufferLength:30,maxMaxBufferLength:60,
        xhrSetup:(_xhr,target)=>{
          const request=new URL(target,window.location.origin);
          if(request.origin!==window.location.origin || request.pathname!=="/api/feed/media")throw new Error("Non-proxy media request refused");
        }});
      player.current=hls;
      hls.on(Hls.Events.ERROR,(_event,data)=>{if(data.fatal)failure.current();});
      hls.attachMedia(element);hls.loadSource(source);
    }).catch(()=>{if(!disposed)failure.current();});
    return ()=>{disposed=true;player.current?.destroy();player.current=null;};
  },[playlist,source]);
  return <video ref={video} controls preload="none" src={playlist?undefined:source} poster={poster}
    onPlay={()=>player.current?.startLoad()} onError={()=>failure.current()} className="max-h-96 max-w-full"/>;
}
