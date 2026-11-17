import {recoveryRow,recoveryView,recoveryGeneration} from './recovery-store-protocol';
import {recoveryCommit} from './recovery-rotation-protocol';
import type {RecoveryRow,RecoveryView} from './recovery-store-save';
type CommitView={generation:number;head:RecoveryView['head'];current:RecoveryRow|null;pending:RecoveryRow|null};
const same=(a:RecoveryRow|null,b:RecoveryRow)=>!!a&&['principal','rotationSeq','signingPub','epub','bytesHex'].every(k=>a[k as keyof RecoveryRow]===b[k as keyof RecoveryRow]);
/** Explicit promotion after published new keys. Conflicts require fresh user action. */
export async function commitRecoveryCopy(row:RecoveryRow,input:{
 current:()=>boolean;signal:AbortSignal;read:(slot:'current'|'pending')=>Promise<unknown>;
 authorize:()=>Promise<void>;sign:(view:CommitView)=>Promise<unknown>;write:(operation:unknown)=>Promise<unknown>;
}):Promise<'committed'|'already-committed'>{
 const expected={...row},guard=()=>{input.signal.throwIfAborted();if(!input.current())throw Error('Recovery context changed');};
 guard();if(!recoveryRow(expected))throw Error('Recovery copy unavailable');
 const read=async():Promise<CommitView>=>{
  const rows:RecoveryView[]=[];
  for(const slot of ['current','pending'] as const){
   guard();const value=await input.read(slot);guard();
   if(!recoveryView(value))throw Error('Recovery read unavailable');
   const raw=value as RecoveryView;
   const view={...raw,head:{...raw.head},row:raw.row?{...raw.row}:null};
   if(view.head.sequence!==expected.rotationSeq||view.head.currentKey!==expected.signingPub||view.head.currentEpub!==expected.epub||
    (view.row&&view.row.principal!==expected.principal))throw Error('Recovery authority changed');
   rows.push(view);
  }
  if(rows[0].generation!==rows[1].generation)throw Error('Recovery generation changed');
  return Object.freeze({generation:rows[0].generation,head:Object.freeze(rows[0].head),
   current:rows[0].row?Object.freeze(rows[0].row):null,pending:rows[1].row?Object.freeze(rows[1].row):null});
 };
 const before=await read();await input.authorize();guard();
 if(same(before.current,expected)&&before.pending===null)return 'already-committed';
 if(!same(before.pending,expected)||before.generation>=Number.MAX_SAFE_INTEGER)throw Error('Pending recovery copy changed');
 const operation=await input.sign(before);guard();if(!recoveryCommit(operation))throw Error('Recovery signature unavailable');
 let result:unknown;try{result=await input.write(operation);}catch{guard();}
 guard();const after=await read();await input.authorize();guard();
 if(after.generation!==before.generation+1||!same(after.current,expected)||after.pending!==null)throw Error('Recovery promotion unconfirmed; reread before committing again');
 if(result!==undefined&&(!recoveryGeneration(result)||(result as {generation:number}).generation!==after.generation))throw Error('Recovery promotion response changed');
 return 'committed';
}
