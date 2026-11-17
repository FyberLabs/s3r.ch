import {walletRotation,rotationPublished,rotationState} from './recovery-rotation-protocol';
import {recoveryView} from './recovery-store-protocol';
import type {RecoveryView} from './recovery-store-save';
type Head=RecoveryView['head'];
type State={recordHash:string;present:boolean;head:Head};
/** One explicit publication, reconciled through the authenticated exact-record lookup.
 * This does not activate pending keys or promote the encrypted backup. */
export async function publishRecoveryRotation(record:unknown,oldHead:Head,input:{
 current:()=>boolean;signal:AbortSignal;
 authorize:()=>Promise<void>;read:(record:Readonly<Record<string,unknown>>)=>Promise<unknown>;
 write:(record:Readonly<Record<string,unknown>>)=>Promise<unknown>;
}):Promise<'published'|'already-published'>{
 const guard=()=>{input.signal.throwIfAborted();if(!input.current())throw Error('Recovery context changed');};
 guard();
 const signed=structuredClone(record) as any,old={...oldHead};
 if(!walletRotation(signed,true)||!recoveryView({generation:0,head:old,row:null})||
  signed.seq!==old.sequence+1||signed.prevKey!==old.currentKey)throw Error('Rotation authority changed');
 Object.freeze(signed.retainedLinks);Object.freeze(signed.authorizer.siwe);Object.freeze(signed.authorizer);Object.freeze(signed);
 const same=(a:Head,b:Head)=>a.sequence===b.sequence&&a.currentKey===b.currentKey&&a.currentEpub===b.currentEpub;
 const next={sequence:signed.seq,currentKey:signed.nextKey,currentEpub:signed.nextEpub};
 const read=async()=>{guard();const value=await input.read(signed);guard();
  if(!rotationState(value))throw Error('Rotation state unavailable');
  const state=value as State;return {...state,head:{...state.head}};
 };
 const before=await read();
 if(before.present){
  if(!same(before.head,next))throw Error('Rotation authority changed');
  return 'already-published';
 }
 if(!same(before.head,old))throw Error('Rotation authority changed');
 await input.authorize();guard();
 let result:unknown;
 try{result=await input.write(signed);}catch{guard();}
 guard();
 const after=await read();
 if(!after.present||after.recordHash!==before.recordHash||!same(after.head,next))throw Error('Rotation publication unconfirmed; reread before publishing again');
 if(result!==undefined&&(!rotationPublished(result)||(result as {recordHash:string}).recordHash!==after.recordHash))throw Error('Rotation publication response changed');
 return 'published';
}
