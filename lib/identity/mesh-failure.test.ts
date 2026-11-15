import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ensureLocalMeshKey,MeshKeySetupError} from './mesh';
import {createMemoryMeshKeyStore} from './idb';
const input={address:'0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',domain:'test.s3r.ch',uri:'https://test.s3r.ch',signMessage:async()=> 'signature'};
for(const stage of ['storage','key-generation','wallet-signature'] as const)test(`bounded ${stage} refusal never writes a partial key`,async()=>{
 let writes=0;
 const store=createMemoryMeshKeyStore();
 const error=Error('PRIVATE SECRET');
 await assert.rejects(ensureLocalMeshKey({...input,store:{get:async address=>{if(stage==='storage')throw error;return store.get(address);},put:async record=>{writes++;await store.put(record);}},createPair:async()=>{if(stage==='key-generation')throw error;return {pub:'pub',priv:'priv',epub:'epub',epriv:'epriv'};},signMessage:async()=>{throw error;}}),e=>e instanceof MeshKeySetupError&&e.stage===stage&&!e.message.includes('PRIVATE'));
 assert.equal(writes,0);
});
