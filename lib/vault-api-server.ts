import { getSquadPilotServer } from './squad-pilot-server';
import { createForumAuthority } from './identity/forum-authority';
import { createVaultScopedStore } from './vault-scoped-store-server';
import { roomAuthorityReadDiagnosticsBlock } from './room-authority-diagnostics';
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
  const stores=new Map<string,ReturnType<typeof createVaultScopedStore>>(config.bindings.map((b:{vaultId:string})=>[b.vaultId,createVaultScopedStore(config,b.vaultId)]));
  const transport=(vaultId:string)=>{const store=stores.get(vaultId);if(!store)throw Error('Unknown vault');return store as ReturnType<typeof createVaultScopedStore>;};
  const resolve=createVaultApiResolver(pilot);
  const service=createVaultApiService({origin:pilot.config.origin,bindings:config.bindings,transport,resolve});
  cached={raw,pilot,service};return service;
}

export function createVaultApiResolver(pilot: Pick<NonNullable<ReturnType<typeof getSquadPilotServer>>, "config" | "source" | "services">, clock=()=>Math.floor(Date.now()/1000)){
  return async(request:Request,signal:AbortSignal)=>{
    const at=clock(),session=await pilot.services.authenticate(request);if(!session)return null;
    const snapshot=await pilot.source.read(at,signal),authority=createForumAuthority(pilot.config.authority,clock);
    const result=await authority.refresh(snapshot,at);signal.throwIfAborted();
    if(!result.ok||roomAuthorityReadDiagnosticsBlock(result.diagnostics,snapshot)||clock()!==at)return null;
    const owner=authority.graph.principalForKey(session.key,at);
    return owner?{owner,key:session.key}:null;
  };
}
