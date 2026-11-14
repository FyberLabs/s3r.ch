"use client";
import { useEffect, useRef } from "react";
import { PostContent, postCardClassName } from "./PostContent";
import { mediaPreviewKind } from "@/lib/media-preview";
export function PrivateMediaPreview({preview}: {preview:{url:string;name:string;mediaType:string;tags?:readonly string[]}}) {
  const kind=mediaPreviewKind(preview.mediaType);
  if(!kind || !preview.url.startsWith("blob:"))return null;
  return <article className={postCardClassName} aria-label="Private media post">
    <PostContent title={preview.name} kind={kind} tags={preview.tags?.map(tag=>`#${tag}`)} tagsLabel={kind==="audio"?"Audio tags":"Image tags"}>
    <figure className="mt-3 space-y-2">
    {kind==="image" ?
      // Decrypted bytes stay in a temporary browser URL, never an image optimizer.
      // eslint-disable-next-line @next/next/no-img-element
      <img src={preview.url} alt={preview.name} className="max-h-[70vh] max-w-full object-contain" /> :
      <PrivateMediaPlayer key={preview.url} kind={kind} url={preview.url} name={preview.name}/> }
    <figcaption>{preview.name}</figcaption>
    </figure>
    </PostContent>
  </article>;
}

function PrivateMediaPlayer({kind,url,name}: {kind:"audio"|"video";url:string;name:string}) {
  const media=useRef<HTMLMediaElement|null>(null);
  useEffect(()=>{
    const element=media.current;
    if(element)element.setAttribute("src",url);
    return ()=>{if(element){element.pause();element.removeAttribute("src");element.load();}};
  },[url]);
  return kind==="audio"
    ? <audio ref={element=>{media.current=element;}} controls preload="metadata" src={url} aria-label={name} className="w-full"/>
    : <video ref={element=>{media.current=element;}} controls playsInline preload="metadata" src={url} aria-label={name} className="max-h-[70vh] max-w-full"/>;
}
