"use client";
import {useEffect,useRef} from "react";
import {attachPublicHls} from "@/lib/public-media-player";
export function PublicFeedVideo({url,poster,onError}:{url:string;poster?:string;onError:()=>void}) {
  const video=useRef<HTMLVideoElement>(null), player=useRef<ReturnType<typeof attachPublicHls>|null>(null);
  const failure=useRef(onError);failure.current=onError;
  const playlist=/\.m3u8(?:$|[?#])/i.test(url);
  const source=`/api/feed/media?${new URLSearchParams({url,kind:"video"})}`;
  useEffect(()=>{
    const element=video.current;if(!element || !playlist)return;
    const controller=attachPublicHls(element,source,window.location.origin,()=>failure.current());
    player.current=controller;
    return ()=>{controller.destroy();player.current=null;};
  },[playlist,source]);
  return <video ref={video} controls preload="none" src={playlist?undefined:source} poster={poster}
    onPlay={()=>player.current?.start()} onError={()=>failure.current()} className="max-h-96 max-w-full"/>;
}
