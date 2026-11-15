import {test} from 'node:test';
import assert from 'node:assert/strict';
import fixture from './identity/vectors/contact-acceptance.json';
import {sealContactMessage,openContactMessage,contactVaultKey,sealContactVault,openContactVault,type ContactContent} from './contact-crypto';
import {contactBase64} from './contact-document-client';
const from=fixture.genesis,to=fixture.mint,now=fixture.context.now;
const pair=(key:typeof to)=>({pub:key.signingPub,priv:key.signingPriv,epub:key.epub,epriv:key.epriv});
const alice={principal:from.signingPub,pub:from.signingPub,epub:from.epub},bob={principal:to.signingPub,pub:to.signingPub,epub:to.epub};
const lane='ab'.repeat(32),message:ContactContent={v:1,id:'cd'.repeat(32),kind:'text',body:'Private hello',issuedAt:now,expiresAt:now+300};
test('only the intended peer opens signed text on the granted lane',async()=>{
 const bytes=await sealContactMessage(lane,pair(from),()=>alice,()=>bob,message,()=>now);
 assert.equal(new TextDecoder().decode(bytes).includes(message.body),false);
 assert.deepEqual(await openContactMessage(lane,pair(to),()=>alice,()=>bob,bytes,()=>now),message);
 await assert.rejects(openContactMessage('ef'.repeat(32),pair(to),()=>alice,()=>bob,bytes,()=>now));
 await assert.rejects(openContactMessage(lane,pair(from),()=>alice,()=>bob,bytes,()=>now));
 const changed=new Uint8Array(bytes);changed[changed.length-1]^=1;
 await assert.rejects(openContactMessage(lane,pair(to),()=>alice,()=>bob,changed,()=>now));
 await assert.rejects(openContactMessage(lane,pair(to),()=>alice,()=>bob,bytes,()=>now+300));
});
test('lock or authority change during encryption prevents ciphertext release',async()=>{
 let calls=0;
 await assert.rejects(sealContactMessage(lane,pair(from),()=>{if(calls++)throw Error('Locked');return alice;},()=>bob,message,()=>now),/Locked/);
});
test('vault roundtrip is owner-bound and never changes a restored contact secret',async()=>{
 const key=await contactVaultKey(pair(to),bob.principal),state={secret:to.contactLaneSecret,blocked:[alice.principal]};
 const bytes=await sealContactVault(key,bob.principal,state);
 assert.equal(new TextDecoder().decode(bytes).includes(to.contactLaneSecret),false);
 assert.deepEqual(await openContactVault(key,bob.principal,contactBase64(bytes)),state);
 await assert.rejects(openContactVault(key,alice.principal,contactBase64(bytes)));
 const other=await contactVaultKey(pair(from),bob.principal);
 await assert.rejects(openContactVault(other,bob.principal,contactBase64(bytes)));
});
