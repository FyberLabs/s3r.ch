import { createHash } from 'node:crypto';
import { createSpanopticonRecordStore } from './spanopticon-record-store-server';
import type { VaultHeadTransport } from './vault-storage-client';
const digest=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
/** Immutable ciphertext is addressed inside its vault, never the tenant-wide
 * object store. Knowing another vault's content digest confers no read access. */
export function createVaultScopedStore(config:{origin:string;tenant:string;apiKey:string},vaultId:string,fetcher:typeof fetch=fetch):VaultHeadTransport{
  if(!/^[a-f0-9]{64}$/.test(vaultId))throw Error('Invalid vault');
  const records=createSpanopticonRecordStore(config,fetcher);
  const objectKey=(id:string)=>{
    if(!/^[a-f0-9]{64}$/.test(id))throw Error('Invalid object');
    const name=createHash('sha256').update('s3rch-vault-object-v1\0'+vaultId+'\0'+id).digest('hex');
    if(name===vaultId)throw Error('Invalid object address');return name;
  };
  const head=(id:string)=>{if(id!==vaultId)throw Error('Invalid vault address');return id;};
  return Object.freeze({
    read:(id:string,signal?:AbortSignal)=>records.get('vault',head(id),signal),
    write:(id:string,bytes:Uint8Array,expected:string|null,signal?:AbortSignal)=>records.put('vault',head(id),bytes,expected,signal),
    async putObject(id:string,input:Uint8Array,signal?:AbortSignal){
      const name=objectKey(id),bytes=new Uint8Array(input);
      if(!bytes.length||bytes.length>8*1024*1024||digest(bytes)!==id)throw Error('Invalid ciphertext');
      try{await records.put('vault',name,bytes,null,signal);}catch{
        signal?.throwIfAborted();
        const saved=await records.get('vault',name,signal);
        if(!saved||digest(saved.bytes)!==id)throw Error('Immutable vault object conflict');
      }
    },
    async getObject(id:string,signal?:AbortSignal){
      const row=await records.get('vault',objectKey(id),signal);
      if(!row)return null;if(digest(row.bytes)!==id)throw Error('Invalid ciphertext');return row.bytes;
    },
  });
}
