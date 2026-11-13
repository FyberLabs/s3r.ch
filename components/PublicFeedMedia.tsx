"use client";
import { PublicFeedVideo } from "./PublicFeedVideo";
import { useRef, useState } from "react";
import { parseFeedMedia, type FeedMedia } from "@/lib/feed-media";
const proxy=(url:string,kind:string)=>`/api/feed/media?${new URLSearchParams({url,kind})}`;
function Attachment({media}:{media:FeedMedia}) {
  const [revealed,setRevealed]=useState(false);
  const dialog=useRef<HTMLDialogElement>(null);
  const [failed,setFailed]=useState(false),[attempt,setAttempt]=useState(0);
  if(media.sensitive && !revealed) return <div className="my-3 border border-rule p-3"><p>{media.warning || "Sensitive media"}</p><button type="button" onClick={()=>setRevealed(true)}>Show media</button></div>;
  const original=<a href={media.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Open original</a>;
  return <figure key={attempt} className="my-3 space-y-2">
    {failed ? <p role="status">Media could not load. <button type="button" onClick={()=>{setFailed(false);setAttempt(value=>value+1);}}>Retry media</button></p>:null}
    {media.kind==="image" ? <><button type="button" aria-label="Expand image" onClick={()=>dialog.current?.showModal()}><img onError={()=>setFailed(true)} src={proxy(media.url,"image")} alt={media.alt || ""} loading="lazy" className="max-h-96 max-w-full object-contain"/></button><dialog ref={dialog} aria-label={media.alt || "Image"} className="m-auto max-h-[95vh] max-w-[95vw] bg-panel p-4 backdrop:bg-black/90"><form method="dialog"><button type="submit" autoFocus>Close image</button></form><img onError={()=>setFailed(true)} src={proxy(media.url,"image")} alt={media.alt || ""} loading="lazy" className="max-h-[85vh] max-w-full object-contain"/></dialog></> : null}
    {media.kind==="video" ? <PublicFeedVideo url={media.url} poster={media.thumbnail ? proxy(media.thumbnail,"image") : undefined} onError={()=>setFailed(true)} /> : null}
    {media.kind==="audio" ? <audio onError={()=>setFailed(true)} controls preload="none" src={proxy(media.url,"audio")}>{original}</audio> : null}
    {media.kind==="link" || media.kind==="quote" ? <blockquote className="border-l-2 border-rule pl-3">{media.thumbnail ? <img onError={()=>setFailed(true)} src={proxy(media.thumbnail,"image")} alt="" loading="lazy" className="max-h-40"/>:null}<p>{media.title || media.author || (media.kind==="quote"?"Quoted post":"Link")}</p>{media.text ? <p>{media.text}</p>:null}</blockquote>:null}
    <figcaption className="text-xs text-ink-muted">{media.alt ? <p>{media.alt}</p>:null}{original}</figcaption>
  </figure>;
}
export default function PublicFeedMedia({media}:{media:unknown}) {
  const items=parseFeedMedia(media);
  return items.length ? <div>{items.map((item,index)=><Attachment key={`${JSON.stringify(item)}:${index}`} media={item}/>)}</div>:null;
}
