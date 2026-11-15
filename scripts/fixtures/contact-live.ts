// Synthetic public keys and mocked services; the production browser adapter and
// cryptography run unchanged. Executed only by the central scheduled UI suite.
import {p256} from '@noble/curves/nist.js';
import {lengthPrefixed,parsePrincipalId,signWithKeyring,verifyKeySignature,type Result} from 'sociacl-ids';
import {openContactWorkspace} from '../../lib/contact-workspace';
import {contactBase64,contactBytes,contactDigest} from '../../lib/contact-document-client';
import fixture from '../../lib/identity/vectors/contact-acceptance.json';
const take=<T>(r:Result<T>):T=>{if(!r.ok)throw Error('Synthetic identity invalid');return r.value;};
const scalar=(n:number)=>{const b=new Uint8Array(32);b[31]=n;return b;};
const url64=(bytes:Uint8Array)=>contactBase64(bytes).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const pub=(n:number)=>{const b=p256.getPublicKey(scalar(n),false);return take(parsePrincipalId(url64(b.slice(1,33))+'.'+url64(b.slice(33))));};
export async function contactLive(){
 const now=1700000060,tenant='12345678-1234-1234-1234-123456789abc',source='23456789-1234-1234-1234-123456789abc';
 const witness=pub(9),jwks={keys:[{kty:'EC',crv:'P-256',kid:'test',x:witness.slice(0,43),y:witness.slice(44),alg:'ES256',use:'sig',key_ops:['verify'],notBefore:0,notAfter:now+7200}]};
 const sign=(bytes:Uint8Array,n:number)=>take(signWithKeyring(scalar(n),bytes,pub(n)));
 const jws=(claims:unknown)=>{const body=url64(new TextEncoder().encode(JSON.stringify({alg:'ES256',kid:'test',typ:'JWT'})))+'.'+url64(new TextEncoder().encode(JSON.stringify(claims)));return body+'.'+url64(p256.sign(new TextEncoder().encode(body),scalar(9),{lowS:false}));};
 const accounts=[1,2].map(n=>{const principal=pub(n),epub=pub(n+10),issuedAt=now-60;return{principal,rotations:[],revocations:[],genesisEpubBindings:[{v:1,kind:'genesis-epub',principal,epub,issuedAt,
  keySig:sign(take(lengthPrefixed(['sociacl-genesis-epub-v1',principal,epub,String(issuedAt)])),n),attest:jws({typ:'sociacl-genesis-epub-attest-v1',principal,epub,iat:issuedAt,exp:now+600})}]};});
 const documents=new Map<string,{revision:number;payload:string}>(),lanes=new Map<string,Map<string,string>>();let loseAppend=false,appendAttempts=0;
 const signal=new AbortController().signal;
 const create=async(n:number)=>{
  let unlocked=true;const principal=pub(n),pair={pub:principal,priv:url64(scalar(n)),epub:pub(n+10),epriv:url64(scalar(n+10))};
  const fetcher=(async(input,init)=>{
   const url=String(input);
   if(url.startsWith('/api/contacts/')){
    if(!unlocked)return new Response(null,{status:403});const body=JSON.parse(String(init?.body)),action=url.split('/').at(-1);
    if(action==='config')return Response.json({at:now,tenant,source,principal,currentKey:principal,trust:{jwks,policy:fixture.context.policy,pinnedIss:[]}});
    if(body.owner!==principal&&body.kind!=='descriptor')return new Response(null,{status:403});
    const account=accounts.find(a=>a.principal===body.owner);if(!account)return new Response(null,{status:403});
    const key=body.owner+':'+body.kind,stored=documents.get(key),fence='ef'.repeat(32);
    if(action==='read')return Response.json({at:now,owner:body.owner,kind:body.kind,revision:stored?.revision??0,payload:stored?.payload??null,fence,
     head:{currentKey:account.principal,currentEpub:account.genesisEpubBindings[0].epub,sequence:0,history:{completeThrough:now,accounts,links:[]}}});
    if(body.owner!==principal||body.revision!==(stored?.revision??0)||body.fence!==fence)return new Response(null,{status:409});
    const digest=await contactDigest(contactBytes(body.payload)),bytes=take(lengthPrefixed(['s3rch-contact-document-v1',tenant,source,principal,body.kind,String(body.revision),String(now),fence,digest]));
    if(!verifyKeySignature(principal,body.signature,bytes).ok)return new Response(null,{status:403});
    documents.set(key,{revision:body.revision+1,payload:body.payload});return Response.json({at:now,revision:body.revision+1,digest});
   }
   if(!url.startsWith('https://plane.example/api/v1/acl/sociacl/'))throw Error('Unexpected network');
   let rows=lanes.get(url);if(!rows){rows=new Map();lanes.set(url,rows);}
   if(init?.method==='GET')return Response.json({messages:[...rows].map(([id,ciphertext])=>({id,ciphertext}))});
   const bytes=new Uint8Array(init?.body as Uint8Array),id=await contactDigest(bytes);rows.set(id,contactBase64(bytes));appendAttempts++;
   if(loseAppend){loseAppend=false;throw Error('Lost append response');}return Response.json({id});
  }) as typeof fetch;
  const workspace=await openContactWorkspace({pair,current:()=>unlocked,subscribe:()=>()=>{},origin:'https://plane.example',signal,fetcher,clock:()=>now});
  await workspace.restore({principal,pub:principal,epub:pair.epub,rotationSeq:0,priorLanes:[],priorContactSecrets:[],laneId:(n===1?'ab':'bc').repeat(32),contactLaneSecret:(n===1?'cd':'de').repeat(32)},signal);
  return {workspace,principal,lock:()=>{unlocked=false;}};
 };
 const alice=await create(1),bob=await create(2);
 await alice.workspace.enableRequests(signal);await bob.workspace.request(alice.principal,'Hello Alice',signal);
 const incoming=await alice.workspace.session.load(signal);if(incoming.requests.length!==1||incoming.contacts.length)throw Error('Explicit acceptance missing');
 await alice.workspace.session.accept(incoming.requests[0].id,signal);
 await bob.workspace.session.load(signal);await alice.workspace.session.messages(bob.principal,signal);
 const message=await bob.workspace.session.prepareMessage(alice.principal,'Private message',signal);loseAppend=true;
 let refused=false;try{await message.submit(signal);}catch{refused=true;}if(!refused)throw Error('Missing ambiguous append');const attempts=appendAttempts;
 await message.submit(signal);if(appendAttempts!==attempts+1)throw Error('Retry did not reuse command');
 const messages=await alice.workspace.session.messages(bob.principal,signal);if(messages.length!==1||messages[0].body!=='Private message')throw Error('Peer message mismatch');
 if((await alice.workspace.session.messages(bob.principal,signal)).length!==1)throw Error('Replay accepted twice');
 await alice.workspace.session.block(bob.principal,signal);refused=false;
 try{await alice.workspace.session.prepareMessage(bob.principal,'Blocked',signal);}catch{refused=true;}if(!refused)throw Error('Blocked contact permitted');
 alice.lock();refused=false;try{await alice.workspace.session.load(signal);}catch{refused=true;}if(!refused)throw Error('Locked identity permitted');
}
Object.assign(window,{contactLive});
