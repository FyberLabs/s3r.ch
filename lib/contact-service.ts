import {parseMediaReaderConfig,type MediaReaderConfig} from './media-wrap-service';
import {contactAction,parseContactRequest,parseContactResult,CONTACT_BODY_LIMIT,CONTACT_RESPONSE_LIMIT} from './contact-document';
import {readBoundedIdentityJson} from './identity/bounded-json';
import {matchesBrowserOrigin} from './request-origin';
const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff',Vary:'Cookie, Origin'};
export function createContactService(config:MediaReaderConfig,siteOrigin:string,
  resolveReader:(request:Request,signal:AbortSignal)=>Promise<string|null>,fetcher:typeof fetch=fetch,clock=()=>Date.now()/1000){
  const held=parseMediaReaderConfig(JSON.stringify(config)),origin=new URL(siteOrigin);
  if(origin.origin!==siteOrigin||origin.protocol!=='https:')throw Error('Invalid contacts origin');
  const credentials=new Map(held.readers.map(r=>[r.principal,r.apiKey])),active=new Set<string>();let preflights=0;
  return async(action:string,request:Request)=>{
    const reply=(status:number)=>new Response(null,{status,headers});
    if(!contactAction(action))return reply(404);
    if(request.method!=='POST')return reply(405);
    if(!matchesBrowserOrigin(request,origin))return reply(403);
    if(request.headers.get('content-type')?.split(';')[0]!=='application/json'||![null,'identity'].includes(request.headers.get('content-encoding')))return reply(415);
    if(preflights+active.size>=2)return reply(429);
    const signal=AbortSignal.any([request.signal,AbortSignal.timeout(4000)]);let reader:string|null=null,occupied=false;
    try{
      preflights++;try{reader=await resolveReader(request,signal);signal.throwIfAborted();}finally{preflights--;}
      if(!reader||!credentials.has(reader))return reply(403);
      if(active.has(reader))return reply(429);active.add(reader);occupied=true;
      let body:Record<string,unknown>;
      try{body=parseContactRequest(action,await readBoundedIdentityJson(new Response(request.body),CONTACT_BODY_LIMIT,signal),reader);}catch{return reply(400);}
      const response=await fetcher(held.origin+'/api/v1/acl/sociacl/contacts/'+action,{method:'POST',credentials:'omit',redirect:'error',cache:'no-store',signal,
        headers:{'Content-Type':'application/json','Accept-Encoding':'identity','X-Tenant-ID':held.tenant,'X-Api-Key':credentials.get(reader)!},body:JSON.stringify(body)});
      if(response.status!==200||response.headers.get('content-type')?.split(';')[0]!=='application/json'||![null,'identity'].includes(response.headers.get('content-encoding'))){
        await response.body?.cancel().catch(()=>{});return reply([403,409,429].includes(response.status)?response.status:503);
      }
      const result=parseContactResult(action,await readBoundedIdentityJson(response,CONTACT_RESPONSE_LIMIT,signal),body,reader,clock());
      if(action==='config'&&'tenant' in result&&result.tenant!==held.tenant)return reply(503);
      if(await resolveReader(request,signal)!==reader)return reply(403);
      signal.throwIfAborted();return Response.json(parseContactResult(action,result,body,reader,clock()),{headers});
    }catch{return reply(503);}finally{if(occupied&&reader)active.delete(reader);}
  };
}
