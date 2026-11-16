import {openGroupItem} from "./media-group-item-reader";
import {createMediaHttpClient} from "./media-client";
import {openMediaFileWithKey} from "./media-file";
import {parseMediaGroupScope,type MediaGroupScope} from "./media-group";
type Input={tenant:string;principal:string;object:string;scope:MediaGroupScope;epriv:string;epub:string;fetcher?:typeof fetch;clock?:()=>number;signal:AbortSignal};
const fail=():never=>{throw Error("Group file access changed");};
type Key=Awaited<ReturnType<typeof openGroupItem>>;
const same=(a:Key,b:Key)=>a.object===b.object&&a.epoch===b.epoch&&a.revisionId===b.revisionId&&a.reference.sha256===b.reference.sha256&&a.reference.length===b.reference.length;
/** Fetch ciphertext first, then obtain fresh authority for decryption and check
 * again before returning plaintext. No plaintext or DEK enters persistent storage. */
export async function openGroupMediaFile(input:Input){
  const held={...input,scope:parseMediaGroupScope(input.scope),signal:AbortSignal.any([input.signal,AbortSignal.timeout(120000)])};
  const initial=await openGroupItem(held);initial.key.fill(0);
  const stored=await createMediaHttpClient(held.fetcher).get(held.object,initial.reference,held.signal,held.scope);
  const current=await openGroupItem(held);
  let opened:Awaited<ReturnType<typeof openMediaFileWithKey>>|undefined;
  try{
    if(!same(initial,current))return fail();
    opened=await openMediaFileWithKey(stored,current.reference.sha256,current.key,{tenant:held.tenant,object:held.object});
    held.signal.throwIfAborted();
    const final=await openGroupItem(held);
    try{if(!same(current,final))return fail();held.signal.throwIfAborted();}
    finally{final.key.fill(0);}
    const result=opened;opened=undefined;return result;
  }finally{current.key.fill(0);opened?.bytes.fill(0);}
}
