import assert from 'node:assert/strict';
import {test} from 'node:test';
import {recoveryRow,recoveryPut,recoveryView,recoveryGeneration} from './recovery-store-protocol';
const p='axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU';
const row={principal:p,signingPub:p,epub:p,rotationSeq:0,bytesHex:'01'+'00'.repeat(60)};
test('recovery wire accepts only bounded public ciphertext and CAS metadata',()=>{
 assert.ok(recoveryRow(row));assert.ok(recoveryPut({action:'put',row,signature:'00'.repeat(64)}));
 for(const bad of [null,{}, {...row,priv:'secret'},{...row,principal:'other'},{...row,rotationSeq:-1},{...row,rotationSeq:1.5},
  {...row,bytesHex:'01'},{...row,bytesHex:'02'+'00'.repeat(60)},{...row,bytesHex:'01'+'0'.repeat(121)},
  {...row,bytesHex:'01'+'AA'.repeat(60)},{...row,bytesHex:'01'+'00'.repeat(524414)}])assert.equal(recoveryRow(bad),false);
 for(const bad of [{action:'commit',row,signature:'00'.repeat(64)},{action:'put',row,signature:'short'},
  {action:'put',row,signature:'00'.repeat(64),passphrase:'secret'}])assert.equal(recoveryPut(bad),false);
 const view={generation:1,head:{sequence:0,currentKey:p,currentEpub:p},row};
 assert.ok(recoveryView({...view,head:{...view.head,diagnostics:[]}}));assert.equal(recoveryView({...view,head:{...view.head,diagnostics:[{reason:'invalid'}]}}),false);assert.equal(recoveryView({...view,head:{...view.head,diagnostics:'bad'}}),false);
 assert.ok(recoveryView(view));assert.ok(recoveryView({...view,row:null,head:{...view.head,currentEpub:null}}));
 for(const bad of [{...view,generation:-1},{...view,head:{...view.head,currentKey:'invalid'}},{...view,head:{...view.head,sequence:Infinity}},
  {...view,row:{...row,priv:'secret'}},{...view,private:'secret'}])assert.equal(recoveryView(bad),false);
 assert.ok(recoveryGeneration({generation:0}));assert.equal(recoveryGeneration({generation:1,secret:'no'}),false);
});
