import {importKeyring,exportKeyring,prepareKeyringRotation,activatePendingKeyring,closeKeyring,closePendingKeyring,type KeyringIdentity,type KeyringState} from 'sociacl-ids/keyring';
import {sealPendingRecoveryKeyring,signRecoveryPendingPut,signPendingWalletRotation} from 'sociacl-ids/recovery';
import {parseEip55,resolveWalletLinkNow,prepareRetainedLinksNow,linkId,signingBytes,checkRotationPublish,type PrincipalId} from 'sociacl-ids';
import {savePendingRecoveryCopy,type RecoveryView} from './recovery-store-save';
import {recoveryRowEnvelope,recoveryRowFile} from './recovery-file';
import {publishRecoveryRotation} from './recovery-rotation-publish';
import {recoveryView} from './recovery-store-protocol';
import {rotationAttestation} from './recovery-rotation-protocol';
import type {LinkedWalletSelection} from './linked-wallet-client';
const hex=(bytes:Uint8Array)=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
export type RotationWallet={current:()=>LinkedWalletSelection|null;signMessage:(message:string,selected:LinkedWalletSelection)=>Promise<string>};
/** One explicit rotation attempt. Secret handles stay local and close on disposal. */
export async function prepareRecoveryRotation(material:Uint8Array,identity:KeyringIdentity,trusted:readonly string[],lost:string,
 passphrase:Uint8Array,accountHandle:string,input:{origin:string;current:()=>boolean;signal:AbortSignal;
 keyringState:(identity:KeyringIdentity)=>Promise<KeyringState>;request:(action:string,value:unknown)=>Promise<unknown>;
 store:(bytes:Uint8Array,identity:KeyringIdentity)=>Promise<unknown>;
}){
 const owner={...identity},devices=[...trusted],plain=new Uint8Array(material),phrase=new Uint8Array(passphrase);
 let closed=false,busy=false,phase:'prepared'|'saved'|'authorized'|'published'|'stored'='prepared';
 let handle:ReturnType<typeof importKeyring>|undefined,pending:ReturnType<typeof prepareKeyringRotation>|undefined;
 let signed:Readonly<Record<string,unknown>>|undefined,walletGuard:(()=>void)|undefined;
 const close=()=>{closed=true;if(pending)closePendingKeyring(pending);if(handle)closeKeyring(handle);input.signal.removeEventListener('abort',close);};
 const guard=()=>{input.signal.throwIfAborted();if(closed||!input.current())throw Error('Rotation context changed');};
 const state=async(id:KeyringIdentity)=>{guard();const current=await input.keyringState(id);guard();return ()=>{guard();return current();};};
 const run=async<T>(operation:()=>Promise<T>)=>{guard();if(busy)throw Error('Rotation operation already running');busy=true;try{return await operation();}finally{busy=false;}};
 input.signal.addEventListener('abort',close,{once:true});
 try{
  guard();const origin=new URL(input.origin);if(origin.protocol!=='https:'||origin.origin!==input.origin)throw Error('Rotation origin unavailable');
  const initial=await state(owner);handle=importKeyring(plain,owner,initial);pending=prepareKeyringRotation(handle,devices,lost,initial);
  const envelope=await sealPendingRecoveryKeyring(pending,phrase,initial,input.signal,accountHandle);guard();
  const row={principal:envelope.principal,rotationSeq:envelope.rotationSeq,signingPub:envelope.signingPub,epub:envelope.epub,bytesHex:hex(envelope.bytes)};
  const head={sequence:owner.rotationSeq,currentKey:owner.pub,currentEpub:owner.epub};
  const ensurePending=async()=>{
   const value=await input.request('recovery-read',{slot:'pending'});guard();
   if(!recoveryView(value))throw Error('Pending backup unavailable');const view=value as RecoveryView;
   if(view.head.sequence!==head.sequence||view.head.currentKey!==head.currentKey||view.head.currentEpub!==head.currentEpub||
    !view.row||Object.keys(row).some(k=>row[k as keyof typeof row]!==view.row![k as keyof typeof row]))throw Error('Pending backup changed');
  };
  return Object.freeze({
   get phase(){return phase;},identity:Object.freeze({principal:pending.principal,pub:pending.pub,epub:pending.epub,rotationSeq:pending.rotationSeq}),
   file(){guard();return recoveryRowFile(row);},close,
   save:()=>run(async()=>{
    if(phase!=='prepared'&&phase!=='saved')throw Error('Rotation already authorized');
    const result=await savePendingRecoveryCopy(row,head,{current:()=>!closed&&input.current(),signal:input.signal,
     read:()=>input.request('recovery-read',{slot:'pending'}),authorize:async()=>{const bytes=exportKeyring(handle!,await state(owner));bytes.fill(0);},
     sign:async view=>signRecoveryPendingPut(handle!,pending!,recoveryRowEnvelope(row),{...view,row:view.row?recoveryRowEnvelope(view.row):null},await state(owner)),
     write:operation=>input.request('recovery-put',operation)});guard();phase='saved';return result;
   }),
   authorize:wallet=>run(async()=>{
    if(phase!=='saved'&&phase!=='authorized')throw Error('Save the pending backup first');signed=undefined;phase='saved';
    const chosen=wallet.current();if(!chosen)throw Error('Connect the linked wallet');const selected=Object.freeze({...chosen});
    const address=parseEip55(selected.address);
    if(!address.ok||!Number.isSafeInteger(Number(selected.chainId))||!/^[1-9][0-9]{0,15}$/.test(selected.chainId)||
     ![selected.walletRevision,selected.sessionRevision].every(v=>Number.isSafeInteger(v)&&v>=0))throw Error('Wallet selection unavailable');
    const check=()=>{guard();const now=wallet.current();if(!now||Object.keys(selected).some(k=>now[k as keyof LinkedWalletSelection]!==selected[k as keyof LinkedWalletSelection]))throw Error('Wallet selection changed');};
    const requireWallet=(snapshot:ReturnType<KeyringState>)=>{
     check();const found=resolveWalletLinkNow(address.value,[...snapshot.context.links.values()],snapshot.context.revocations??[],snapshot.context);
     if(!found.ok||found.value.principal!==owner.principal)throw Error('Linked wallet unavailable');const id=linkId(found.value);if(!id.ok)throw Error('Linked wallet unavailable');return id.value;
    };
    await ensurePending();check();const current=await state(owner),snapshot=current(),link=requireWallet(snapshot);
    const candidates=[...snapshot.context.links].filter(([,v])=>!!v&&typeof v==='object'&&(v as {principal?:unknown}).principal===owner.principal).map(([id])=>id);
    const retained=prepareRetainedLinksNow(candidates,snapshot.context);if(!retained.ok||!retained.value.includes(link))throw Error('Current links unavailable');
    const uri=origin.origin+'/identity/link',policy=snapshot.context.policy;
    if(!policy.allowedDomains.includes(origin.host)||!policy.allowedUris.includes(uri)||!policy.allowedChainIds.includes(selected.chainId))throw Error('Wallet policy unavailable');
    const {version:_,...draft}=pending!.draft;
    const candidate={...draft,issuedAt:snapshot.context.now,retainedLinks:retained.value,authorizer:{kind:'wallet' as const,link,siwe:{message:'',signature:''}}};
    const transcript=signingBytes(candidate as Parameters<typeof signingBytes>[0]);if(!transcript.ok)throw Error('Rotation transcript unavailable');
    const digest=hex(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(transcript.value))));check();
    const nonce=hex(crypto.getRandomValues(new Uint8Array(16)));
    const message=`${origin.host} wants you to sign in with your Ethereum account:\n${selected.address}\n\nSociACL link: ${digest}\n\nURI: ${uri}\nVersion: 1\nChain ID: ${selected.chainId}\nNonce: ${nonce}\nIssued At: ${new Date(candidate.issuedAt*1000).toISOString().replace('.000Z','Z')}`;
    const signature=await wallet.signMessage(message,selected);check();candidate.authorizer.siwe={message,signature};
    const fresh=await state(owner);if(requireWallet(fresh())!==link)throw Error('Linked wallet changed');
    const request=signPendingWalletRotation(pending!,candidate,fresh);
    const witness=await input.request('rotation-witness',request);check();if(!rotationAttestation(witness))throw Error('Rotation witness unavailable');
    const final=await state(owner);if(requireWallet(final())!==link)throw Error('Linked wallet changed');
    signPendingWalletRotation(pending!,candidate,final);
    const full={...request,attest:(witness as {attest:string}).attest},last=final();
    if(!checkRotationPublish(full,[],owner.principal as PrincipalId,last.rotations,last.context).ok)throw Error('Rotation witness rejected');
    await ensurePending();check();signed=Object.freeze(full);walletGuard=check;phase='authorized';
   }),
   publish:()=>run(async()=>{
    if(!signed||!['authorized','published','stored'].includes(phase))throw Error('Authorize the rotation first');
    walletGuard!();
    const result=await publishRecoveryRotation(signed,head,{current:()=>!closed&&input.current(),signal:input.signal,
     read:async record=>{walletGuard!();const result=await input.request('rotation-state',{record});walletGuard!();return result;},write:record=>{walletGuard!();return input.request('rotation-publish',record);},
     authorize:async()=>{await ensurePending();const current=await state(owner);signPendingWalletRotation(pending!,Object.fromEntries(Object.entries(signed!).filter(([k])=>!['attest','nextSig'].includes(k))),current);}});
    guard();if(phase!=='stored')phase='published';return result;
   }),
   protect:()=>run(async()=>{
    if(phase!=='published')throw Error('Confirm publication first');
    const next={principal:pending!.principal,pub:pending!.pub,epub:pending!.epub,rotationSeq:pending!.rotationSeq};
    const current=await state(next),active=activatePendingKeyring(pending!,current);let bytes:Uint8Array|undefined;
    try{bytes=exportKeyring(active,current);guard();await input.store(bytes,next);guard();phase='stored';}
    finally{bytes?.fill(0);closeKeyring(active);close();}
   }),
  } satisfies {readonly phase:string;readonly identity:KeyringIdentity;file:()=>Uint8Array;close:()=>void;save:()=>Promise<string>;authorize:(wallet:RotationWallet)=>Promise<void>;publish:()=>Promise<string>;protect:()=>Promise<void>});
 }catch(error){close();throw error;}
 finally{plain.fill(0);phrase.fill(0);}
}
