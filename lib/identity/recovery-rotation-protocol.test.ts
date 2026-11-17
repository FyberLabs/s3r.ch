import assert from 'node:assert/strict';
import {test} from 'node:test';
import vectors from './vectors/forum-rotation-record.json';
import {walletRotation,rotationAttestation,rotationPublished,rotationState,recoveryCommit} from './recovery-rotation-protocol';
const signed:any=vectors.accept.find((row:any)=>row.input.nextEpub&&row.input.authorizer.kind==='wallet')!.input;
const {attest,...request}=signed;
test('rotation transport admits only exact public wallet records',()=>{
 assert.ok(walletRotation(request));assert.ok(walletRotation(signed,true));
 for(const value of [null,{},signed,{...request,priv:'secret'},{...request,nextEpub:'invalid'},
  {...request,authorizer:{...request.authorizer,siwe:{message:1,signature:'x'}}},
  {...request,authorizer:{...request.authorizer,siwe:{message:'x'.repeat(8193),signature:'x'}}},
  {...request,authorizer:{...request.authorizer,siwe:{message:'x',signature:'invalid'}}},
  {...request,authorizer:{...request.authorizer,siwe:{message:{priv:'secret'},signature:request.authorizer.siwe.signature}}},
  {...request,authorizer:{...request.authorizer,siwe:{message:'x',signature:{priv:'secret'}}}},
  {...request,nextSig:'invalid'},{...request,seq:-1},{...request,authorizer:{...request.authorizer,secret:'private'}},
  {...request,authorizer:{kind:'oidc-fresh-login',link:request.authorizer.link}},
  {...request,authorizer:{...request.authorizer,siwe:{message:'x',signature:'x',priv:'secret'}}}])assert.equal(walletRotation(value),false);
 for(const value of [{...signed,attest:''},{...signed,attest:0},{...signed,attest:'x'.repeat(128*1024+1)}])assert.equal(walletRotation(value,true),false);
 assert.equal(walletRotation(new Proxy({}, {ownKeys(){throw Error();}})),false);
});
test('rotation replies and promotion signatures exclude private or ambiguous fields',()=>{
 assert.ok(rotationAttestation({attest}));assert.ok(rotationPublished({recordHash:'ab'.repeat(32)}));
 for(const value of [{attest:''},{attest,priv:'secret'},{attest:'x'.repeat(128*1024+1)}])assert.equal(rotationAttestation(value),false);
 assert.equal(rotationPublished({recordHash:'bad'}),false);
 const state={recordHash:'ab'.repeat(32),present:true,head:{sequence:1,currentKey:signed.nextKey,currentEpub:signed.nextEpub}};
 assert.ok(rotationState(state));
 for(const value of [{...state,present:1},{...state,secret:'x'},{...state,head:{}},
  {...state,head:{...state.head,sequence:-1}},{...state,head:{...state.head,currentKey:'bad'}},
  {...state,head:{...state.head,currentEpub:null}}])assert.equal(rotationState(value),false);
 assert.ok(recoveryCommit({action:'commit',signature:'00'.repeat(64)}));
 for(const value of [{action:'put',signature:'00'.repeat(64)},{action:'commit',signature:'bad'},
  {action:'commit',signature:'00'.repeat(64),priv:'secret'}])assert.equal(recoveryCommit(value),false);
});
