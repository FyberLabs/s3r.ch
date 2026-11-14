import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {test} from 'node:test';
import {exportOperatorBinding, signOperatorSeaStatement} from './operator-binding-export';
import {operatorBindingStatement} from './operator-binding';
import {verifyForumKeySignature} from './forum-key-signature';
const generated=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({format:'jwk'});
const pair={pub:`${generated.x}.${generated.y}`,priv:generated.d!,epub:'unused',epriv:'unused'};
const address='0x4C8d36f87287e75D3D84F1aeD72655ecCbC7A1A7';
const row={domain:'test.s3r.ch',wallet:address,sea_public_key:pair.pub,timestamp:1};
test('browser WebCrypto signs the native verifier bytes with the existing SEA key',async()=>{
  const signature=await signOperatorSeaStatement(pair,row,()=>true);
  assert.ok(verifyForumKeySignature(pair.pub,signature,new TextEncoder().encode(operatorBindingStatement(row,'sea-to-wallet'))));
  assert.equal(verifyForumKeySignature(pair.pub,signature,new TextEncoder().encode(operatorBindingStatement(row,'wallet-to-sea'))),false);
});
test('locked, changed, foreign-origin or foreign-wallet contexts refuse',async()=>{
  await assert.rejects(signOperatorSeaStatement(pair,row,()=>false));
  await assert.rejects(signOperatorSeaStatement(pair,{...row,sea_public_key:'other'},()=>true));
  for(const change of [{current:()=>false},{origin:'https://s3r.ch'},{address:'foreign'}]) {
    await assert.rejects(exportOperatorBinding({address,origin:'https://test.s3r.ch',pair,current:()=>true,
      timestamp:1,signWallet:async()=>{assert.fail('must not ask wallet');},...change}),/not exported/);
  }
});
test('wallet rejection and context changes return no declaration',async()=>{
  await assert.rejects(exportOperatorBinding({address,origin:'https://test.s3r.ch',pair,current:()=>true,timestamp:1,
    signWallet:async()=>{throw Error('private provider error');}}),/^Error: Operator binding was not exported/);
  let live=true;
  await assert.rejects(exportOperatorBinding({address,origin:'https://test.s3r.ch',pair,current:()=>live,timestamp:1,
    signWallet:async()=>{live=false;return 'invalid';}}),/not exported/);
});
