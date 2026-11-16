import {parseMediaGroupScope} from "./media-group";
type WrapService=(request:Request)=>Promise<Response>;
type GroupService=(action:string,request:Request)=>Promise<Response>;
/** Invoke only the strict session-bound BFF services. A selected group scope is
 * a request for fresh joint authorization, never a client-supplied grant. */
export async function authorizeMediaCiphertext(input:{origin:string;request:Request;object:string;signal:AbortSignal;wrap:()=>WrapService|null;group?:()=>GroupService|null}){
 const {origin,request,object,signal}=input,query=new URL(request.url).searchParams;
 let scope:ReturnType<typeof parseMediaGroupScope>|undefined;
 if(query.size){
  if(query.size!==2||query.getAll('predicate').length!==1||query.getAll('set').length!==1)return false;
  try{scope=parseMediaGroupScope({predicate:query.get('predicate'),set:query.get('set')});}catch{return false;}
 }
 const service=scope?input.group?.():input.wrap();if(!service)return false;
 const headers=new Headers(request.headers);headers.set('origin',origin);headers.set('content-type','application/json');
 headers.delete('content-length');headers.delete('content-encoding');
 const internal=new Request(origin+'/api/media/'+(scope?'groups/item-wrap-read':'read-wrap'),{
  method:'POST',headers,body:JSON.stringify({object,...scope}),signal});
 const response=scope?await (service as GroupService)('item-wrap-read',internal):await (service as WrapService)(internal);
 try{signal.throwIfAborted();return response.status===200;}finally{await response.body?.cancel().catch(()=>{});}
}
