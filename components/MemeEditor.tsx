"use client";
import {useEffect,useRef,useState} from "react";
import {drawMeme,rasterDimensions,MEME_FILE_MAX,MEME_CAPTION_MAX,type MemeLayout} from "@/lib/meme-image";
export function MemeEditor(){
 const canvas=useRef<HTMLCanvasElement|null>(null),bitmap=useRef<ImageBitmap|null>(null),generation=useRef(0),download=useRef<string|null>(null);
 const [revision,setRevision]=useState(0),[top,setTop]=useState(""),[bottom,setBottom]=useState(""),[layout,setLayout]=useState<MemeLayout>("overlay"),[background,setBackground]=useState<"dark"|"light">("dark");
 const [notice,setNotice]=useState(""),[busy,setBusy]=useState(false),[url,setUrl]=useState<string|null>(null),[valid,setValid]=useState(true),[drawError,setDrawError]=useState("");
 function invalidate(){generation.current++;if(download.current)URL.revokeObjectURL(download.current);download.current=null;setUrl(null);}
 function clear(){invalidate();if(canvas.current)canvas.current.width=canvas.current.width;bitmap.current?.close();bitmap.current=null;setTop("");setBottom("");setBusy(false);setNotice("");setRevision(n=>n+1);}
 useEffect(()=>{const changed=()=>clear();const storage=(event:StorageEvent)=>{if(event.key===null||event.key==="s3rch-session-changed")clear();};window.addEventListener("pagehide",changed);window.addEventListener("storage",storage);window.addEventListener("s3rch-session-changed",changed);return()=>{window.removeEventListener("pagehide",changed);window.removeEventListener("storage",storage);window.removeEventListener("s3rch-session-changed",changed);generation.current++;bitmap.current?.close();if(download.current)URL.revokeObjectURL(download.current);};},[]);
 useEffect(()=>{try{if(canvas.current)drawMeme(canvas.current,bitmap.current,top,bottom,layout,background);setValid(true);setDrawError("");}catch(error){setValid(false);setDrawError(error instanceof Error?error.message:"Could not draw this image.");}},[top,bottom,layout,background,revision]);
 async function select(file:File|undefined){
  invalidate();const token=generation.current;bitmap.current?.close();bitmap.current=null;setRevision(n=>n+1);setBusy(true);setNotice("");
  try{
   if(!file || !file.size || file.size>MEME_FILE_MAX)throw Error("Choose a PNG or JPEG up to 8 MiB.");
   const bytes=new Uint8Array(await file.arrayBuffer());if(token!==generation.current)return;const info=rasterDimensions(bytes);
   const decoded=await createImageBitmap(new Blob([bytes],{type:info.type}));
   if(token!==generation.current){decoded.close();return;}
   if(!decoded.width||!decoded.height||decoded.width>4096||decoded.height>4096){decoded.close();throw Error("Image dimensions are unsupported.");}
   bitmap.current=decoded;setRevision(n=>n+1);
  }catch(error){if(token===generation.current)setNotice(error instanceof Error?error.message:"Could not open this image.");}
  finally{if(token===generation.current)setBusy(false);}
 }
 async function exportImage(){
  invalidate();const token=generation.current;setBusy(true);setNotice("");
  try{
   if(!canvas.current||!valid)throw Error("Check the image and captions first.");
   drawMeme(canvas.current,bitmap.current,top,bottom,layout,background);
   const blob=await new Promise<Blob>((resolve,reject)=>canvas.current!.toBlob(value=>value?resolve(value):reject(Error("Could not export this image.")),"image/png"));
   if(token!==generation.current)return;
   const next=URL.createObjectURL(blob);download.current=next;setUrl(next);
  }catch(error){if(token===generation.current)setNotice(error instanceof Error?error.message:"Could not export this image.");}
  finally{if(token===generation.current)setBusy(false);}
 }
 return <section className="mx-auto max-w-3xl space-y-4 px-4 py-8">
  <h1 className="text-2xl font-semibold">Image draft editor</h1>
  <p>Create a captioned image and save a PNG. Your image stays in this browser tab. Clearing or leaving the page discards the draft.</p>
  <p className="text-sm text-ink-muted">Coming in v1: publish as an image post with tags and sharing controls.</p>
  <fieldset disabled={busy} className="space-y-3 disabled:opacity-50">
   <label className="block">Image (PNG or JPEG, up to 8 MiB)<input className="block" type="file" accept="image/png,image/jpeg" onChange={event=>{const file=event.target.files?.[0];event.target.value="";if(file)void select(file);}}/></label>
   <label className="block">Layout<select className="ml-3 border" value={layout} onChange={event=>{invalidate();setLayout(event.target.value as MemeLayout);}}><option value="overlay">Text on image</option><option value="panel">Caption panel</option></select></label>
   <label className="block">Blank template<select className="ml-3 border" value={background} onChange={event=>{invalidate();setBackground(event.target.value as "dark"|"light");}}><option value="dark">Dark</option><option value="light">Light</option></select></label>
   <label className="block">Top caption<input className="block w-full border p-2" maxLength={MEME_CAPTION_MAX} value={top} onChange={event=>{invalidate();setTop(event.target.value);}}/></label>
   <label className="block">Bottom caption<input className="block w-full border p-2" maxLength={MEME_CAPTION_MAX} value={bottom} onChange={event=>{invalidate();setBottom(event.target.value);}}/></label>
  </fieldset>
  <canvas ref={canvas} role="img" aria-label={["Image draft",top,bottom].filter(Boolean).join(": ")} className="max-w-full border"/>
  <div className="flex gap-4"><button type="button" className="underline" disabled={busy||!valid} onClick={()=>void exportImage()}>Prepare PNG</button><button type="button" className="underline" onClick={clear}>Clear draft</button>{url?<a className="underline" href={url} download="s3rch-image.png">Save PNG</a>:null}</div>
  <p role="status" aria-live="polite">{busy?"Preparing image…":notice||drawError}</p>
 </section>;
}
