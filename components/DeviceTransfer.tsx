'use client';
import {useEffect,useState} from 'react';
import {ReceiverFlow,SenderFlow} from 'sea-device-link-ui';
import 'sea-device-link-ui/styles.css';
import {createDeviceClient,readDeviceSession,type DeviceSession} from '@/lib/identity/device-client';
import {deviceRecords,type DeviceRecord} from '@/lib/identity/device-storage';
import {subscribeUnlockedMeshPair} from '@/lib/identity/unlocked-mesh';
import {identitySessionChanged} from './useIdentitySession';
export function DeviceTransfer(){
 const [session,setSession]=useState<DeviceSession>(),[generation,setGeneration]=useState(0),[failed,setFailed]=useState(false);
 useEffect(()=>{
  const abort=new AbortController();setSession(undefined);setFailed(false);
  void readDeviceSession(abort.signal).then(s=>{if(!abort.signal.aborted)setSession(s);}).catch(()=>{if(!abort.signal.aborted)setFailed(true);});
  return ()=>abort.abort();
 },[generation]);
 useEffect(()=>{
  const change=()=>setGeneration(v=>v+1),off=subscribeUnlockedMeshPair(change);
  const storage=(e:StorageEvent)=>{if(e.key==='s3rch-session-changed')change();};
  window.addEventListener('s3rch-session-changed',change);window.addEventListener('storage',storage);
  return ()=>{off();window.removeEventListener('s3rch-session-changed',change);window.removeEventListener('storage',storage);};
 },[]);
 useEffect(()=>{if(!session?.expiresAt)return;const t=setTimeout(()=>setGeneration(v=>v+1),Math.max(0,session.expiresAt-Date.now()));return ()=>clearTimeout(t);},[session]);
 return <div className="space-y-4 py-4"><p>Transfer your existing identity to a device you control. Confirm the full comparison on both devices. Your source identity stays on its device.</p>
  {failed?<p role="alert">Device transfer is unavailable. The application needs its configured identity services.</p>:!session?<p role="status">Checking authorization…</p>:!session.authorized?<div><p>Authorize device transfer with your existing account on each device. This does not link or merge accounts.</p><a href="/api/identity/device/authorize">Authorize device transfer</a></div>:<Session key={generation} session={session}/>}
 </div>;
}
function Session({session}:{session:DeviceSession}){
 const [client,setClient]=useState<ReturnType<typeof createDeviceClient>>(),[records,setRecords]=useState<DeviceRecord[]>([]),[mode,setMode]=useState<'sender'|'receiver'>('receiver'),[status,setStatus]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{
  let active=true;const refresh=()=>{void deviceRecords().then(r=>{if(active)setRecords(r);}).catch(()=>{if(active)setStatus('Local identity storage is unavailable.');});};
  const value=createDeviceClient(session,location.origin,refresh);setClient(value);refresh();
  return ()=>{active=false;value.dispose();};
 },[session]);
 async function work(fn:()=>Promise<string>){setBusy(true);setStatus('');try{setStatus(await fn());}catch{setStatus('Unable to finish. Saved identities are preserved. Check authorization and local protection before retrying.');}finally{setBusy(false);}}
 return <div className="space-y-4"><p>Transfer authorization expires after five minutes. Reauthorize to continue with a saved identity.</p>
  <div className="flex gap-4"><button disabled={busy||mode==='receiver'} onClick={()=>setMode('receiver')}>Receive existing identity</button><button disabled={busy||mode==='sender'} onClick={()=>setMode('sender')}>Send from this device</button></div>
  {client&&mode==='receiver'&&<ReceiverFlow adapters={client.adapters} help="Use a PRF-capable passkey on this device. Import preserves the complete keyring; sign-in is a separate step below."/>}
  {client&&mode==='sender'&&<><p>Unlock your existing identity first. Previously received complete identities can be unlocked here with their passkey. Older pair-only storage needs its complete SociACL keyring JSON export; missing historical keys cannot be recreated.</p>
   <label>Load complete local keyring JSON export <input type="file" disabled={busy} onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(!file)return;void work(async()=>{if(file.size>524288)throw Error();const bytes=new Uint8Array(await file.arrayBuffer());try{await client.selectCompleteSource(bytes);return 'Complete source keyring validated for this identity.';}finally{bytes.fill(0);}});}}/></label>
   <SenderFlow adapters={client.adapters}/></>}
  {records.map(record=><section key={record.address}><h2>Saved identity</h2><p className="break-all">{record.principal}</p><p>Import is saved locally. Signing in does not copy source sessions or grant memberships.</p>
   <button disabled={busy||!client} onClick={()=>void work(async()=>{await client!.resume(record);return 'Saved completion acknowledged. No identity was imported again.';})}>Retry saved acknowledgement</button>{' '}
   <button disabled={busy||!client} onClick={()=>void work(async()=>{const ok=await client!.signIn(record);if(ok){identitySessionChanged();return 'Signed in with the saved identity.';}return 'Identity saved; sign-in failed. Retry sign-in without importing again.';})}>Unlock saved identity and sign in</button>
  </section>)}
  {status&&<p role="status">{status}</p>}
 </div>;
}
