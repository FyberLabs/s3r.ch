import {parseMediaReaderConfig,type MediaReaderConfig} from "./media-wrap-service";
import {isGroupCommand,parseGroupCommand,parseGroupCommandResult,groupRequestLimit,groupResponseLimit} from "./media-group-command";
import {readBoundedIdentityJson} from "./identity/bounded-json";
import {matchesBrowserOrigin} from "./request-origin";
const headers={"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff",Vary:"Cookie, Origin"};

export function createMediaGroupService(config:MediaReaderConfig,siteOrigin:string,
  resolvePrincipal:(request:Request,signal:AbortSignal)=>Promise<string|null>,fetcher:typeof fetch=fetch,clock=()=>Date.now()/1000) {
  const held=parseMediaReaderConfig(JSON.stringify(config)),origin=new URL(siteOrigin);
  if(origin.protocol!=="https:"||origin.origin!==siteOrigin)throw Error("Invalid site origin");
  const credentials=new Map(held.readers.map(row=>[row.principal,row.apiKey]));
  const active=new Set<string>();let preflights=0;
  return async(action:string,request:Request)=>{
    const reply=(status:number)=>new Response(null,{status,headers});
    if(!isGroupCommand(action))return reply(404);
    if(request.method!=="POST")return reply(405);
    if(!matchesBrowserOrigin(request,origin))return reply(403);
    if(request.headers.get("content-type")?.split(";")[0]!=="application/json"||![null,"identity"].includes(request.headers.get("content-encoding")))return reply(415);
    if(preflights+active.size>=2)return reply(429);
    const signal=AbortSignal.any([request.signal,AbortSignal.timeout(4000)]);
    let principal:string|null=null,occupied=false;
    try {
      preflights++;
      try{principal=await resolvePrincipal(request,signal);signal.throwIfAborted();}finally{preflights--;}
      if(!principal||!credentials.has(principal))return reply(403);
      if(active.has(principal))return reply(429);
      active.add(principal);occupied=true;
      let body:Record<string,unknown>;
      try{body=parseGroupCommand(action,await readBoundedIdentityJson(new Response(request.body),groupRequestLimit(action),
        AbortSignal.any([signal,AbortSignal.timeout(1000)])),principal);}catch{return reply(400);}
      signal.throwIfAborted();
      const response=await fetcher(held.origin+"/api/v1/acl/sociacl/media/groups/"+action,{
        method:"POST",credentials:"omit",redirect:"error",cache:"no-store",signal,
        headers:{"Content-Type":"application/json","Accept-Encoding":"identity","X-Tenant-ID":held.tenant,"X-Api-Key":credentials.get(principal)!},body:JSON.stringify(body)});
      if(response.status!==200||response.headers.get("content-type")?.split(";")[0]!=="application/json"||![null,"identity"].includes(response.headers.get("content-encoding"))){
        await response.body?.cancel().catch(()=>{});return reply([403,409,429].includes(response.status)?response.status:503);
      }
      const result=parseGroupCommandResult(action,await readBoundedIdentityJson(response,groupResponseLimit(action),signal),body,clock(),principal);
      if(await resolvePrincipal(request,signal)!==principal)return reply(403);
      signal.throwIfAborted();
      return Response.json(parseGroupCommandResult(action,result,body,clock(),principal),{headers});
    }catch{return reply(503);}finally{if(occupied&&principal)active.delete(principal);}
  };
}
