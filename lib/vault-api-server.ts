import { getSquadPilotServer } from './squad-pilot-server';
import { createForumAuthority } from './identity/forum-authority';
import { createSpanopticonVaultTransport } from './vault-storage-transport-server';
import { createVaultApiService } from './vault-api-service';
let cached:{raw:string;pilot:unknown;service:ReturnType<typeof createVaultApiService>}|undefined;
export function getVaultApiService(){
  const raw=process.env.S3RCH_VAULT_STORAGE;
  if(raw===undefined){cached=undefined;return null;}
  const pilot=getSquadPilotServer();if(!pilot)throw Error('Vault identity unavailable');
  if(cached?.raw===raw&&cached.pilot===pilot)return cached.service;
  cached=undefined;
  if(raw.length>65536)throw Error('Invalid vault configuration');
  const config=JSON.parse(raw);
  if(!config||Object.keys(config).sort().join()!=='apiKey,bindings,origin,tenant'||!Array.isArray(config.bindings)||config.bindings.length>128)
    throw Error('Invalid vault configuration');
  const transport=createSpanopticonVaultTransport(config);
  const resolve=async(request:Request,signal:AbortSignal)=>{
    const at=Math.floor(Date.now()/1000),session=await pilot.services.authenticate(request);if(!session)return null;
    const snapshot=await pilot.source.read(at,signal),authority=createForumAuthority(pilot.config.authority,()=>Math.floor(Date.now()/1000));
    const result=await authority.refresh(snapshot,at);signal.throwIfAborted();
    if(!result.ok||result.diagnostics.length||Math.floor(Date.now()/1000)!==at)return null;
    const owner=authority.graph.principalForKey(session.key,at);
    return owner?{owner,key:session.key}:null;
  };
  const service=createVaultApiService({origin:pilot.config.origin,bindings:config.bindings,transport,resolve});
  cached={raw,pilot,service};return service;
}
