const fail=():never=>{throw Error("Owner maintenance wrap unavailable");};
const exact=(v:unknown,keys:readonly string[]):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
export function parseOwnerWrapResult(v:unknown,body:Record<string,unknown>,now:number){
  if(!exact(v,["payload","object","predicate","set_id","epoch","revision_id","reader_epub","key_commitment","item_digest","expires_at"])||
      v.object!==body.object||v.predicate!==body.predicate||v.set_id!==body.set||typeof v.reader_epub!=="string"||!v.reader_epub||v.reader_epub.length>1024||
      !Number.isSafeInteger(v.epoch)||(v.epoch as number)<1||!Number.isFinite(now)||!Number.isSafeInteger(v.expires_at)||(v.expires_at as number)<=now||(v.expires_at as number)>now+2||
      [v.revision_id,v.key_commitment,v.item_digest].some(d=>typeof d!=="string"||!/^[a-f0-9]{64}$/.test(d))||
      typeof v.payload!=="string"||v.payload.length>87384||!v.payload||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v.payload))return fail();
  return structuredClone(v);
}
