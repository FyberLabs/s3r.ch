'use client';
import {useEffect,useRef,useState} from 'react';
import {useMediaTenant} from './useMediaTenant';
import {PrivateMediaPreview} from './PrivateMediaPreview';
import {createForumMemory,type ForumMemoryState} from '@/lib/forum-memory';
import {collectionKey,encodeForumCollection,type ForumCollection} from '@/lib/forum-collections';
import {subscribeUnlockedMeshPair} from '@/lib/identity/unlocked-mesh';
export function ForumMemoryMap(props:{sessionKey:string;current():boolean;collections:readonly ForumCollection[];writable:boolean;send(body:string):Promise<boolean>}){
  const tenant=useMediaTenant(),live=useRef(props);live.current=props;
  const [state,setState]=useState<ForumMemoryState|null>(null),[choice,setChoice]=useState(''),[label,setLabel]=useState(''),[notice,setNotice]=useState(''),[sending,setSending]=useState(false);
  const client=useRef<ReturnType<typeof createForumMemory>|null>(null),pending=useRef(false);
  useEffect(()=>{
    if(!tenant)return;
    const held=createForumMemory({key:props.sessionKey,tenant,current:()=>live.current.current()&&document.visibilityState!=='hidden',
      collections:()=>live.current.collections,changed:setState});client.current=held;
    const reset=()=>{held.reset();setChoice('');setLabel('');setNotice('');};
    const off=subscribeUnlockedMeshPair(reset);
    window.addEventListener('s3rch-session-changed',reset);
    const hidden=()=>{if(document.visibilityState==='hidden')reset();};document.addEventListener('visibilitychange',hidden);
    const lease=setInterval(()=>{if(!live.current.current()){reset();}else held.tick();},250);
    // Refresh only after the user explicitly opens the catalog. The current
    // catalog lease bounds retained previews during network or authority loss.
    const refresh=setInterval(()=>{if(document.visibilityState!=='hidden'&&live.current.current())void held.refreshIfLoaded();},2000);
    return()=>{clearInterval(lease);clearInterval(refresh);off();window.removeEventListener('s3rch-session-changed',reset);document.removeEventListener('visibilitychange',hidden);held.dispose();client.current=null;};
  },[tenant,props.sessionKey]);
  const scopes=new Map((state?.entries??[]).map(entry=>[collectionKey(entry),entry]));
  const collections=props.collections.filter(scope=>scopes.has(collectionKey(scope)));
  async function link(){
    const selected=scopes.get(choice);if(pending.current||!selected||!props.current()||!props.writable)return;
    pending.current=true;setSending(true);setNotice('');
    try{const body=encodeForumCollection({...selected,label:label.trim()});if(await props.send(body)){setLabel('');setChoice('');setNotice('Collection reference sent. It appears after verification.');}else setNotice('Collection reference was not sent.');}
    catch{setNotice('Use a short collection label and refresh your access.');}finally{pending.current=false;setSending(false);}
  }
  return <section aria-label="Shared media collections" className="space-y-3 border border-rule p-4">
    <h2 className="font-semibold">Shared photos and video</h2>
    <p>Forum access does not grant access to files. Each open checks your current group and file permissions.</p>
    {!tenant?<p>{tenant===undefined?'Loading media configuration…':'Media is not available here.'}</p>:<>
      <button disabled={state?.busy} onClick={()=>void client.current?.refresh(0)}>Open or refresh shared collections</button>
      {state?.message&&<p role="status">{state.message}</p>}
      {state?.loaded&&<>
        <p>Granted page {state.page+1} of 16. Empty pages are valid.</p>
        {!collections.length&&<p>No linked collection with current access on this page.</p>}
        {collections.map(scope=><section key={collectionKey(scope)} aria-label={scope.label}><h3>{scope.label}</h3>
          <ul>{state.entries.filter(entry=>collectionKey(entry)===collectionKey(scope)).map((entry,index)=><li key={entry.object}>
            <button disabled={state.busy} onClick={()=>void client.current?.open(entry)}>Open photo or video {index+1}</button>
          </li>)}</ul></section>)}
        <button disabled={state.busy||state.page===0} onClick={()=>void client.current?.refresh(state.page-1)}>Previous page</button>
        <button disabled={state.busy||state.nextPage===null} onClick={()=>void client.current?.refresh(state.nextPage!)}>Next page</button>
        {props.writable&&<form onSubmit={event=>{event.preventDefault();void link();}} className="space-y-2">
          <p>Link a collection you can access. Its label and group reference are published as a signed forum statement; this does not share files or change grants.</p>
          <label className="block">Collection<select value={choice} disabled={state.busy||sending} onChange={event=>setChoice(event.target.value)}><option value="">Choose from this Granted page</option>
            {[...scopes].map(([key,scope],index)=><option key={key} value={key}>Group {index+1} · {scope.set}</option>)}</select></label>
          <label className="block">Label<input value={label} maxLength={40} disabled={state.busy||sending} onChange={event=>setLabel(event.target.value)}/></label>
          <button disabled={state.busy||sending||!scopes.has(choice)||!label.trim()}>Link collection</button>
        </form>}
      </>}
      {state?.preview&&<PrivateMediaPreview preview={state.preview}/>}
      {notice&&<p role="status">{notice}</p>}
    </>}
  </section>;
}
