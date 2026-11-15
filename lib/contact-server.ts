import {getSquadPilotServer} from './squad-pilot-server';
import {createForumAuthority} from './identity/forum-authority';
import {parseMediaReaderConfig} from './media-wrap-service';
import {createContactService} from './contact-service';
let cached:{raw:string;pilot:unknown;service:ReturnType<typeof createContactService>}|undefined;
export function getContactService(){
  const raw=process.env.S3RCH_CONTACT_READER_BINDINGS;
  if(raw===undefined){cached=undefined;return null;}
  const pilot=getSquadPilotServer();if(!pilot)throw Error('Contact identity unavailable');
  if(cached?.raw===raw&&cached.pilot===pilot)return cached.service;
  cached=undefined;const config=parseMediaReaderConfig(raw);
  if(config.tenant!==process.env.S3RCH_STATEMENT_SOURCE_TENANT_ID)throw Error('Contact tenant mismatch');
  const resolveReader=async(request:Request,signal:AbortSignal)=>{
    const at=Math.floor(Date.now()/1000),session=await pilot.services.authenticate(request);if(!session)return null;
    const snapshot=await pilot.source.read(at,signal),authority=createForumAuthority(pilot.config.authority,()=>Math.floor(Date.now()/1000));
    const result=await authority.refresh(snapshot,at);signal.throwIfAborted();
    if(!result.ok||result.diagnostics.length||Math.floor(Date.now()/1000)!==at)return null;
    return authority.graph.principalForKey(session.key,at);
  };
  const service=createContactService(config,pilot.config.origin,resolveReader);cached={raw,pilot,service};return service;
}
