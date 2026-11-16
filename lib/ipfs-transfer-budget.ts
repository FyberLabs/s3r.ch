/** Optional same-origin, cross-tab payload admission. Not a server quota or wire-byte meter. */
import {IPFS_MEDIA_BLOCK_BYTES} from "./ipfs-media-blocks";
const DB="s3rch-ipfs-transfer-budget-v1", STORE="budget", MINUTE=60_000, MAX=8*IPFS_MEDIA_BLOCK_BYTES;
const denied=()=>new Error("Shared IPFS transfer budget unavailable");
type Entry={at:number;bytes:number};
function open(factory:IDBFactory):Promise<IDBDatabase>{
  return new Promise((resolve,reject)=>{
    let done=false;
    const fail=()=>{if(!done){done=true;clearTimeout(timer);reject(denied());}};
    const request=factory.open(DB,1),timer=setTimeout(fail,2000);
    request.onupgradeneeded=()=>{request.result.createObjectStore(STORE);};
    request.onerror=fail;request.onblocked=fail;
    request.onsuccess=()=>{if(done){request.result.close();return;}done=true;clearTimeout(timer);resolve(request.result);};
  });
}
export function createSharedTransferBudget(options:{maxBytesPerMinute:number;current:()=>boolean;factory?:IDBFactory;now?:()=>number}){
  const limit=options.maxBytesPerMinute,factory=options.factory??globalThis.indexedDB,now=options.now??Date.now,current=options.current;
  if(!Number.isSafeInteger(limit)||limit<1||limit>MAX)throw denied();
  let closed=false,pending=0;const running=new Set<IDBTransaction>();
  function check(signal:AbortSignal){if(closed||signal.aborted||current()!==true)throw denied();}
  return Object.freeze({
    close(){closed=true;for(const tx of running){try{tx.abort();}catch{/* complete */}}},
    async reserve(bytes:number,signal:AbortSignal):Promise<void>{
      check(signal);
      if(!Number.isSafeInteger(bytes)||bytes<1||bytes>IPFS_MEDIA_BLOCK_BYTES||pending>=2)throw denied();
      pending++;let db:IDBDatabase|undefined;
      try{
        db=await open(factory);check(signal);
        await new Promise<void>((resolve,reject)=>{
          const tx=db!.transaction(STORE,"readwrite"),store=tx.objectStore(STORE);running.add(tx);
          const cancel=()=>{try{tx.abort();}catch{/* complete */}};
          const timer=setTimeout(cancel,2000);signal.addEventListener("abort",cancel,{once:true});
          const finish=()=>{clearTimeout(timer);signal.removeEventListener("abort",cancel);running.delete(tx);};
          tx.onabort=()=>{finish();reject(denied());};tx.oncomplete=()=>{finish();resolve();};
          const request=store.get("shared");
          request.onsuccess=()=>{try{
            check(signal);const at=now(),row=request.result;
            if(!Number.isSafeInteger(at)||at<0||at>Number.MAX_SAFE_INTEGER-MINUTE)throw denied();
            let entries:Entry[]=[];
            if(row!==undefined){
              if(!row||!Number.isSafeInteger(row.last)||row.last<0||row.last>at||!Array.isArray(row.entries)||row.entries.length>128)throw denied();
              let previous=0,total=0;
              for(const entry of row.entries){
                if(!entry||!Number.isSafeInteger(entry.at)||entry.at<previous||entry.at>row.last||!Number.isSafeInteger(entry.bytes)||entry.bytes<1||entry.bytes>IPFS_MEDIA_BLOCK_BYTES)throw denied();
                previous=entry.at;total+=entry.bytes;if(total>MAX)throw denied();
                if(at-entry.at<MINUTE)entries.push({at:entry.at,bytes:entry.bytes});
              }
            }
            if(entries.length>=128||bytes>limit-entries.reduce((sum,entry)=>sum+entry.bytes,0))throw denied();
            entries.push({at,bytes});store.put({last:at,entries},"shared");
          }catch{cancel();}};
        });
        check(signal); // A committed reservation is never refunded, even on late cancellation.
      }finally{db?.close();pending--;}
    },
  });
}
