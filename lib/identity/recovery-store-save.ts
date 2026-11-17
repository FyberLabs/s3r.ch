import {recoveryRow,recoveryView,recoveryGeneration,recoveryPut} from './recovery-store-protocol';
export type RecoveryRow={principal:string;rotationSeq:number;signingPub:string;epub:string;bytesHex:string};
export type RecoveryView={generation:number;head:{sequence:number;currentKey:string;currentEpub:string|null};row:RecoveryRow|null};
const same=(a:RecoveryRow|null,b:RecoveryRow)=>!!a&&['principal','rotationSeq','signingPub','epub','bytesHex'].every(k=>a[k as keyof RecoveryRow]===b[k as keyof RecoveryRow]);
/** One explicit save. A lost response permits read-back, never a repeated write. */
export type RecoverySaveInput={
 current:()=>boolean;signal:AbortSignal;read:()=>Promise<unknown>;
 authorize:(view:RecoveryView)=>Promise<void>;
 sign:(view:RecoveryView)=>Promise<unknown>;write:(operation:unknown)=>Promise<unknown>;
};
export async function saveRecoveryCopy(row:RecoveryRow,input:RecoverySaveInput){
 return saveCopy(row,input,{sequence:row.rotationSeq,currentKey:row.signingPub,currentEpub:row.epub});
}
/** Persist the future encrypted copy while the old head still authorizes its CAS. */
export async function savePendingRecoveryCopy(row:RecoveryRow,head:RecoveryView['head'],input:RecoverySaveInput){
 const expected={...row},authority={...head};
 if(!recoveryView({generation:0,head:authority,row:null})||!Number.isSafeInteger(authority.sequence+1)||
  expected.rotationSeq!==authority.sequence+1||expected.signingPub===authority.currentKey||expected.epub===authority.currentEpub)throw Error('Pending recovery authority changed');
 return saveCopy(expected,input,authority);
}
async function saveCopy(row:RecoveryRow,input:RecoverySaveInput,authority:RecoveryView['head']):Promise<'stored'|'already-stored'>{
 const guard=()=>{input.signal.throwIfAborted();if(!input.current())throw Error('Recovery context changed');};
 const expected={...row};
 const view=async()=>{guard();const value=await input.read();guard();if(!recoveryView(value))throw Error('Recovery read unavailable');
  const raw=value as RecoveryView;
  const parsed=Object.freeze({...raw,head:Object.freeze({...raw.head}),row:raw.row?Object.freeze({...raw.row}):null});
  if(parsed.row&&parsed.row.principal!==expected.principal)throw Error('Recovery owner changed');
  if(parsed.head.sequence!==authority.sequence||parsed.head.currentKey!==authority.currentKey||parsed.head.currentEpub!==authority.currentEpub)throw Error('Recovery authority changed');
  await input.authorize(parsed);guard();return parsed;
 };
 guard();if(!recoveryRow(expected))throw Error('Recovery copy unavailable');
 const before=await view();
 if(same(before.row,expected))return 'already-stored';
 if(before.generation>=Number.MAX_SAFE_INTEGER)throw Error('Recovery generation exhausted');
 const operation=await input.sign(before);guard();
 if(!recoveryPut(operation)||!same((operation as {row:RecoveryRow}).row,expected))throw Error('Recovery signature unavailable');
 let result:unknown;
 try{result=await input.write(operation);}catch{guard();}
 guard();
 // Reconcile success and ambiguous response loss through the same owner read.
 const after=await view();
 if(after.generation!==before.generation+1||!same(after.row,expected))throw Error('Recovery save unconfirmed; reread before saving again');
 if(result!==undefined&&(!recoveryGeneration(result)||(result as {generation:number}).generation!==after.generation))throw Error('Recovery save response changed');
 return 'stored';
}
