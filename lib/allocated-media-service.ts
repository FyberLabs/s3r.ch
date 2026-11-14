import type { AllocatedMediaStore } from "./allocated-media-store-server";
import { createMediaObjectService } from "./media-object-service";
import { createMediaRegistrationService } from "./media-registration-service";
import type { UnverifiedObjectRecord } from "./identity/forum-object-record";

type OwnerService=(action:string,request:Request)=>Promise<Response>;
type WrapService=(request:Request)=>Promise<Response>;
/** Only pass the strict fixed-subject owner/wrap services, never raw upstream fetch. */
export function createAllocatedMediaService(input:{
  origin:string;allocated:AllocatedMediaStore;
  owner:()=>OwnerService|null;wrap:()=>WrapService|null;
}) {
  const forbidden=async():Promise<never>=>{throw Error("Legacy media storage disabled");};
  async function authorize(request:Request,object:string,action:"read"|"write"|"register",signal:AbortSignal,candidate?:UnverifiedObjectRecord) {
    const owner=input.owner(),wrap=action==="read"?input.wrap():null;
    if(action==="read"?!wrap:!owner)return false;
    signal.throwIfAborted();
    const headers=new Headers(request.headers);
    headers.set("origin",input.origin);headers.set("content-type","application/json");
    headers.delete("content-length");headers.delete("content-encoding");
    const operation=candidate?"registration":"view";
    const internal=new Request(input.origin+"/api/media/"+(action==="read"?"read-wrap":"owner/"+operation),{
      method:"POST",headers,signal,body:JSON.stringify(candidate?{object,record:candidate}:{object}),
    });
    const response=action==="read"?await wrap!(internal):await owner!(operation,internal);
    try{signal.throwIfAborted();return response.status===200;}
    finally{await response.body?.cancel().catch(()=>{});}
  }
  const objects=createMediaObjectService({origin:input.origin,allocated:input.allocated,authorize,
    objects:{get:forbidden,put:forbidden,delete:forbidden},records:{get:forbidden,put:forbidden,delete:forbidden}});
  // Existing upload clients expect registration acknowledgement. In this mode
  // the protected source verifies the signed record; no duplicate index is written.
  const register=createMediaRegistrationService({origin:input.origin,authorize,
    preflight:(request,object,signal)=>authorize(request,object,"register",signal),
    store:{get:forbidden,admit:async()=>{},remove:forbidden}});
  return async(request:Request,object:string)=>{
    if(request.method==="DELETE")return new Response(null,{status:405,headers:{"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}});
    return request.method==="POST"?register(request,object):objects(request,object);
  };
}
