import { createHash } from 'node:crypto';
import { verifyForumKeySignature } from './identity/forum-key-signature';
import { readBoundedIdentityJson } from './identity/bounded-json';
import { matchesBrowserOrigin } from './request-origin';
import { VAULT_API_LIMIT, vaultOperationBytes, type VaultOperation } from './vault-api-contract';
import type { VaultHeadTransport } from './vault-storage-client';
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Cookie, Origin' };
export function createVaultApiService(input: { origin: string; bindings: readonly {owner:string;vaultId:string}[];
  transport: VaultHeadTransport; resolve(request:Request,signal:AbortSignal):Promise<{owner:string;key:string}|null>; clock?:()=>number }) {
  const origin = new URL(input.origin), clock = input.clock ?? (()=>Math.floor(Date.now()/1000));
  if (origin.origin !== input.origin || origin.protocol !== 'https:') throw Error('Invalid vault origin');
  const bindings = new Map<string,string>();
  for (const b of input.bindings) {
    if (!/^[a-f0-9]{64}$/.test(b.vaultId) || typeof b.owner !== 'string' || bindings.has(b.vaultId)) throw Error('Invalid vault binding');
    bindings.set(b.vaultId,b.owner);
  }
  let active = 0;
  return async (request:Request):Promise<Response> => {
    const reply=(status:number)=>new Response(null,{status,headers});
    if(request.method!=='POST')return reply(405);
    if(!matchesBrowserOrigin(request,origin))return reply(403);
    if(request.headers.get('content-type')?.split(';')[0]!=='application/json'||![null,'identity'].includes(request.headers.get('content-encoding')))return reply(415);
    if(active>=2)return reply(429);
    active++;
    const signal=AbortSignal.any([request.signal,AbortSignal.timeout(120_000)]);
    try {
      const session=await input.resolve(request,signal); signal.throwIfAborted();
      if(!session)return reply(403);
      let op:VaultOperation, sig:string, bytes:Uint8Array|undefined;
      try {
        const body=await readBoundedIdentityJson(new Response(request.body),VAULT_API_LIMIT,signal) as {op:VaultOperation;sig:string;bytes:string|null};
        if(!body||Object.keys(body).sort().join()!=='bytes,op,sig')throw Error();
        op=body.op;sig=body.sig;vaultOperationBytes(op);
        const write=op.action==='write'||op.action==='putObject';
        if(write){
          if(typeof body.bytes!=='string'||!/^[A-Za-z0-9+/]+={0,2}$/.test(body.bytes))throw Error();
          bytes=Buffer.from(body.bytes,'base64');
          if(!bytes.length||bytes.length>8*1024*1024||Buffer.from(bytes).toString('base64')!==body.bytes||createHash('sha256').update(bytes).digest('hex')!==op.digest)throw Error();
        }else if(body.bytes!==null)throw Error();
      } catch{return reply(400);}
      const authorize=async()=>{
        signal.throwIfAborted();const fresh=await input.resolve(request,signal);signal.throwIfAborted();const now=clock();
        return fresh?.owner===session.owner&&fresh.key===session.key&&op.origin===origin.origin&&op.owner===fresh.owner&&
          bindings.get(op.vaultId)===fresh.owner&&op.issuedAt<=now&&now<op.expiresAt&&verifyForumKeySignature(fresh.key,sig,vaultOperationBytes(op));
      };
      if(!await authorize())return reply(403);
      let result:unknown;
      switch(op.action){
        case 'read': {const row=await input.transport.read(op.id,signal);result=row?{bytes:Buffer.from(row.bytes).toString('base64'),revision:row.revision}:null;break;}
        case 'write': result={revision:await input.transport.write(op.id,bytes!,op.expected,signal)};break;
        case 'getObject': {const b=await input.transport.getObject(op.id,signal);result=b?{bytes:Buffer.from(b).toString('base64')}:null;break;}
        case 'putObject': await input.transport.putObject(op.id,bytes!,signal);result={ok:true};break;
      }
      if(!await authorize())return reply(403);
      return Response.json(result,{headers});
    }catch{return reply(503);}finally{active--;}
  };
}
