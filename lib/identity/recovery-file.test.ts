import assert from 'node:assert/strict';
import {test} from 'node:test';
import {recoveryFileRow,recoveryRowFile,recoveryRowEnvelope} from './recovery-file';
const p='axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU';
const row={principal:p,signingPub:p,epub:p,rotationSeq:0,bytesHex:'01'+'00'.repeat(60)};
test('bounded file and owner wire roundtrip without secret fields',()=>{
 assert.deepEqual(recoveryFileRow(recoveryRowFile(row)),row);assert.equal(recoveryRowEnvelope(row).bytes.length,61);
 const file=JSON.parse(new TextDecoder().decode(recoveryRowFile(row)));
 for(const input of [{...file,priv:'secret'},{...file,version:2},{...file,ciphertext:file.ciphertext+'='},{...file,ciphertext:''},{...file,principal:'bad'}])assert.throws(()=>recoveryFileRow(new TextEncoder().encode(JSON.stringify(input))));
 for(const input of [new Uint8Array(),new Uint8Array(710001),new Uint8Array([255])])assert.throws(()=>recoveryFileRow(input));
 assert.throws(()=>recoveryRowFile({...row,bytesHex:'bad'}));
});
