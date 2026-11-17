'use client';
import {useEffect,useRef,useState} from 'react';
import {encodePassphrase,RecoveryWeakPassphraseError} from 'sociacl-ids/recovery';
import {connectRecoveryWallet,type RecoveryWalletProvider} from '@/lib/identity/recovery-wallet';
import type {createDeviceClient} from '@/lib/identity/device-client';
import type {RestoredKeyringRecord} from '@/lib/identity/restored-keyring-storage';
type Client=ReturnType<typeof createDeviceClient>;
type Flow=Awaited<ReturnType<Client['prepareRotation']>>;
export function RecoveryRotation({client,previous,onBusy}:{client:Client;previous:RestoredKeyringRecord;onBusy?:(busy:boolean)=>void}){
 const flow=useRef<Flow|undefined>(undefined),wallet=useRef<Awaited<ReturnType<typeof connectRecoveryWallet>>|undefined>(undefined);
 const revision=useRef(0),active=useRef(true),abort=useRef(new AbortController());
 const pass=useRef<HTMLInputElement>(null),confirm=useRef<HTMLInputElement>(null),lost=useRef<HTMLInputElement>(null),trusted=useRef<HTMLTextAreaElement>(null),account=useRef<HTMLInputElement>(null);
 const [busy,setBusy]=useState(false),[phase,setPhase]=useState('empty'),[status,setStatus]=useState(''),[download,setDownload]=useState<string>(),[address,setAddress]=useState('');
 const clear=()=>{revision.current++;client.cancelRotation();flow.current?.close();flow.current=undefined;wallet.current?.close();wallet.current=undefined;if(pass.current)pass.current.value='';if(confirm.current)confirm.current.value='';};
 useEffect(()=>{active.current=true;abort.current=new AbortController();return ()=>{active.current=false;clear();abort.current.abort();};},[client]);
 useEffect(()=>()=>{if(download)URL.revokeObjectURL(download);},[download]);
 const cancel=()=>{clear();setPhase('empty');setAddress('');setBusy(false);onBusy?.(false);setStatus('Local rotation attempt cleared. A saved pending backup or published rotation is unchanged. Keep your downloaded file.');};
 async function work(operation:(check:()=>void)=>Promise<string>){
  if(busy)return;const generation=revision.current;const check=()=>{if(!active.current||generation!==revision.current)throw Error('Rotation changed');};
  setBusy(true);onBusy?.(true);setStatus('');try{const result=await operation(check);check();setPhase(flow.current?.phase??'empty');setStatus(result);}
  catch(error){if(active.current&&generation===revision.current)setStatus(error instanceof RecoveryWeakPassphraseError?'Choose a stronger new recovery passphrase. '+error.warning:'Rotation step could not be confirmed. Keep your downloaded backup. Retry only after checking current state; no write is automatically repeated.');}
  finally{if(active.current&&generation===revision.current){setBusy(false);onBusy?.(false);}}
 }
 return <section className="space-y-3"><h2>Recover after losing a device</h2>
  <p>Start from your restored identity. This prepares new keys, preserves historical decryption keys, and requires your currently linked browser wallet before publication. Keep the encrypted download until recovery is verified.</p>
  <label>Lost device ID <input ref={lost} disabled={busy||phase!=='empty'} autoComplete="off"/></label>
  <label>Trusted device IDs, one per line (include the lost device) <textarea ref={trusted} disabled={busy||phase!=='empty'}/></label>
  <label>Recovery account handle <input ref={account} disabled={busy||phase!=='empty'} autoComplete="off"/></label>
  <label>New rotation recovery passphrase <input ref={pass} type="password" autoComplete="new-password" disabled={busy||phase!=='empty'}/></label>
  <label>Confirm rotation recovery passphrase <input ref={confirm} type="password" autoComplete="new-password" disabled={busy||phase!=='empty'}/></label>
  <button disabled={busy||phase!=='empty'} onClick={()=>void work(async check=>{
   const prior=structuredClone(previous),ids=(trusted.current?.value??'').split('\n').map(v=>v.trim()).filter(Boolean),lostId=lost.current?.value.trim()??'',handle=account.current?.value??'';
   let phrase:Uint8Array|undefined,other:Uint8Array|undefined,file:Uint8Array|undefined;
   try{
    phrase=encodePassphrase(pass.current?.value??'');other=encodePassphrase(confirm.current?.value??'');
    if(pass.current)pass.current.value='';if(confirm.current)confirm.current.value='';
    if(phrase.length!==other.length||phrase.some((b,i)=>b!==other![i]))throw Error('Passphrases differ');
    const prepared=await client.prepareRotation(prior,ids,lostId,phrase,handle);
    try{check();file=prepared.file();const url=URL.createObjectURL(new Blob([new Uint8Array(file)],{type:'application/json'}));flow.current=prepared;setDownload(url);}
    catch(error){prepared.close();throw error;}
    return 'New keys and encrypted backup prepared locally. Download the file before saving the pending backup.';
   }finally{phrase?.fill(0);other?.fill(0);file?.fill(0);}
  })}>Prepare recovery rotation</button>
  {download&&<a href={download} download="s3rch-pending-recovery.json">Download pending recovery backup</a>}
  <button disabled={busy||!['prepared','saved'].includes(phase)} onClick={()=>void work(async()=>{await flow.current!.save();return 'Pending encrypted backup saved and verified. Your current keys have not changed.';})}>Save pending rotation backup</button>
  <button disabled={busy||!['saved','authorized'].includes(phase)} onClick={()=>void work(async check=>{
   wallet.current?.close();const provider=(globalThis as {ethereum?:RecoveryWalletProvider}).ethereum;
   if(!provider)throw Error('Connect a browser wallet first');const connected=await connectRecoveryWallet(provider,abort.current.signal,cancel);
   try{check();wallet.current=connected;setAddress(connected.current()!.address);}catch(error){connected.close();throw error;}
   await flow.current!.authorize(connected);check();return 'Linked wallet authorization verified. Publish only when you intend to replace the current account keys.';
  })}>Authorize rotation with linked wallet</button>
  {address&&<p>Authorizing wallet: {address}</p>}
  <button disabled={busy||!['authorized','published'].includes(phase)} onClick={()=>void work(async()=>{await flow.current!.publish();return 'Exact rotation publication confirmed. Protect the new keys on this device next.';})}>Publish and confirm rotation</button>
  <button disabled={busy||phase!=='published'} onClick={()=>void work(async()=>{await flow.current!.protect();return 'Confirmed new keys are protected locally. Unlock them below to sign in, then make the downloaded pending backup current in recovery controls.';})}>Protect confirmed rotated keys</button>
  <button onClick={cancel}>Cancel rotation attempt</button>
  <p role="status">{status}</p>
 </section>;
}
