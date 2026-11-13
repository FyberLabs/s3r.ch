"use client";
import { useState } from "react";
import { parseFeedMedia, type FeedMedia } from "@/lib/feed-media";
const proxy=(url:string,kind:string)=>`/api/feed/media?${new URLSearchParams({url,kind})}`;
function Attachment({media}:{media:FeedMedia}) {
  const [revealed,setRevealed]=useState(false),[expanded,setExpanded]=useState(false);
  if(media.sensitive && !revealed) return <div className="my-3 border border-rule p-3"><p>{media.warning || "Sensitive media"}</p><button type="button" onClick={()=>setRevealed(true)}>Show media</button></div>;
  const original=<a href={media.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Open original</a>;
  return <figure className="my-3 space-y-2">
    {media.kind==="image" ? <><button type="button" aria-label="Expand image" onClick={()=>setExpanded(true)}><img src={proxy(media.url,"image")} alt={media.alt || ""} loading="lazy" className="max-h-96 max-w-full object-contain"/></button>{expanded ? <div role="dialog" aria-modal="true" aria-label={media.alt || "Image"} className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/90 p-6" onKeyDown={event=>{if(event.key==="Escape")setExpanded(false);}}><button type="button" autoFocus onClick={()=>setExpanded(false)}>Close image</button><img src={proxy(media.url,"image")} alt={media.alt || ""} className="max-h-[85vh] max-w-full object-contain"/></div>:null}</> : null}
    {media.kind==="video" ? <video controls preload="none" src={proxy(media.url,"video")} poster={media.thumbnail ? proxy(media.thumbnail,"image") : undefined} className="max-h-96 max-w-full">{original}</video> : null}
    {media.kind==="audio" ? <audio controls preload="none" src={proxy(media.url,"audio")}>{original}</audio> : null}
    {media.kind==="link" || media.kind==="quote" ? <blockquote className="border-l-2 border-rule pl-3">{media.thumbnail ? <img src={proxy(media.thumbnail,"image")} alt="" loading="lazy" className="max-h-40"/>:null}<p>{media.title || media.author || (media.kind==="quote"?"Quoted post":"Link")}</p>{media.text ? <p>{media.text}</p>:null}</blockquote>:null}
    <figcaption className="text-xs text-ink-muted">{media.alt ? <p>{media.alt}</p>:null}{original}</figcaption>
  </figure>;
}
export default function PublicFeedMedia({media}:{media:unknown}) {
  const items=parseFeedMedia(media);
  return items.length ? <div>{items.map((item,index)=><Attachment key={`${item.kind}:${item.url}:${index}`} media={item}/>)}</div>:null;
}
