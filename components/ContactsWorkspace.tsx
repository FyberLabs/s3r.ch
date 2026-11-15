'use client';
import {useEffect,useRef,useState} from 'react';
import {IdentityBar} from './IdentityBar';
import {ContactInbox} from './ContactInbox';
import {useIdentitySessionState} from './useIdentitySession';
import {readSingleUnlockedIdentity,readUnlockedMeshRevision,subscribeUnlockedMeshPair} from '@/lib/identity/unlocked-mesh';
import {openContactWorkspace} from '@/lib/contact-workspace';
type Workspace=Awaited<ReturnType<typeof openContactWorkspace>>;
export function ContactsWorkspace({origin}:{origin:string|null}){
 const identity=useIdentitySessionState(),identityRef=useRef(identity);identityRef.current=identity;
 const [workspace,setWorkspace]=useState<Workspace|null>(null),[ready,setReady]=useState(false),[busy,setBusy]=useState(false),[status,setStatus]=useState('');
 const [peer,setPeer]=useState(''),[message,setMessage]=useState('');
 const operation=useRef<AbortController|null>(null),generation=useRef(0),listeners=useRef(new Set<()=>void>());
 function reset(){generation.current++;operation.current?.abort();operation.current=null;setWorkspace(null);setReady(false);setBusy(false);setPeer('');setMessage('');setStatus('');for(const listener of listeners.current)listener();}
 useEffect(()=>{reset();},[identity]); // A newly evaluated session requires a fresh adapter.
 useEffect(()=>{
  const off=subscribeUnlockedMeshPair(reset),hidden=()=>{if(document.visibilityState==='hidden')reset();};
  window.addEventListener('s3rch-session-changed',reset);document.addEventListener('visibilitychange',hidden);
  return()=>{generation.current++;operation.current?.abort();off();window.removeEventListener('s3rch-session-changed',reset);document.removeEventListener('visibilitychange',hidden);};
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[]);
 async function run(action:(signal:AbortSignal)=>Promise<void>){
  if(operation.current)return;const controller=new AbortController(),held=generation.current;operation.current=controller;setBusy(true);setStatus('');
  const timer=setTimeout(()=>controller.abort(),30000);
  try{await action(controller.signal);controller.signal.throwIfAborted();}
  catch{if(generation.current===held)setStatus('Contacts could not complete this action. Refresh or retry.');}
  finally{clearTimeout(timer);if(operation.current===controller){operation.current=null;setBusy(false);}}
 }
 async function connect(signal:AbortSignal){
  const selected=readSingleUnlockedIdentity(),session=identityRef.current,held=generation.current;
  if(!selected||!session||!origin)throw Error('Unlock required');
  const current=()=>generation.current===held&&identityRef.current===session&&readUnlockedMeshRevision()===selected.revision;
  const next=await openContactWorkspace({pair:selected.pair,current,subscribe:listener=>{listeners.current.add(listener);return()=>{listeners.current.delete(listener);};},origin,signal});
  signal.throwIfAborted();if(!current())throw Error('Identity changed');setWorkspace(next);setReady(next.ready);
 }
 return <section className="mx-auto max-w-3xl space-y-4 px-4 py-8">
  <h1 className="text-2xl font-semibold">Contacts</h1><IdentityBar/>
  {!origin?<p>Contacts are not available on this site yet.</p>:<>
   <button disabled={busy||!identity} onClick={()=>void run(connect)}>Open my contacts</button>
   {status&&<p role="status">{status}</p>}
   {workspace&&!ready&&<label className="block">Restore your existing contact keyring
    <p>Your saved contact keys are required. They are encrypted in your account before being stored.</p>
    <input type="file" accept="application/json,.json" disabled={busy} onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(!file)return;void run(async signal=>{if(file.size>300000)throw Error('File too large');const value=JSON.parse(await file.text());signal.throwIfAborted();await workspace.restore(value,signal);signal.throwIfAborted();if(!workspace.session.current())throw Error('Identity changed');setReady(true);});}}/>
   </label>}
   {workspace&&ready&&<>
    <button disabled={busy} onClick={()=>void run(async signal=>{await workspace.enableRequests(signal);signal.throwIfAborted();setStatus('Contact requests are enabled for seven days.');})}>Enable contact requests</button>
    <button disabled={busy} onClick={()=>void run(async signal=>{await workspace.disableRequests(signal);signal.throwIfAborted();setStatus('New contact requests are disabled.');})}>Disable contact requests</button>
    <form className="space-y-2" onSubmit={event=>{event.preventDefault();void run(async signal=>{await workspace.request(peer,message,signal);signal.throwIfAborted();setMessage('');setStatus('Contact request sent.');});}}>
     <label className="block">Contact account<input className="block w-full border rounded p-2" value={peer} onChange={event=>setPeer(event.target.value)} disabled={busy} autoComplete="off" spellCheck={false}/></label>
     <label className="block">Introduction<textarea className="block w-full border rounded p-2" value={message} onChange={event=>setMessage(event.target.value)} maxLength={1024} disabled={busy}/></label>
     <button disabled={busy||!peer||!message.trim()}>Send contact request</button>
    </form>
    <ContactInbox session={workspace.session}/>
   </>}
  </>}
 </section>;
}
