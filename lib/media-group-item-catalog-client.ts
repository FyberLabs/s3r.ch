import {parseGroupGrantedRequest,parseGroupGrantedPage} from "./media-group-item-catalog";
import {readBoundedIdentityJson} from "./identity/bounded-json";
export async function readGroupGranted(page:number,principal:string,fetcher:typeof fetch=fetch,signal?:AbortSignal,clock=()=>Date.now()/1000){
  const body=parseGroupGrantedRequest({page},principal),held=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(4000)]);held.throwIfAborted();
  const response=await fetcher('/api/media/groups/item-reader-catalog',{method:'POST',credentials:'same-origin',redirect:'error',cache:'no-store',signal:held,
    headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(response.status!==200||response.headers.get('content-type')?.split(';')[0]!=="application/json"){
    await response.body?.cancel().catch(()=>{});throw Error("Granted group media unavailable");
  }
  const value=parseGroupGrantedPage(await readBoundedIdentityJson(response,8192,held),page,principal,clock());held.throwIfAborted();return value;
}
