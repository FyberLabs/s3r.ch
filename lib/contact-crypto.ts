/** Browser-only authenticated envelopes over the opaque contact transport. */
import {lengthPrefixed,signWithKeyring,verifyKeySignature,parsePrincipalId} from 'sociacl-ids';
import type {SeaPair} from './identity/sea';
import {contactText} from './contact-inbox-view';
import {contactBase64,contactBytes} from './contact-document-client';
export type ContactPeer=Readonly<{principal:string;pub:string;epub:string}>;
export type ContactContent=Readonly<{v:1;id:string;kind:'text'|'grant';body:string;issuedAt:number;expiresAt:number}>;
const domain='s3rch-contact-message-v1',hex=/^[0-9a-f]{64}$/;
const fail=():never=>{throw Error('Invalid contact ciphertext');};
const raw=(s:string)=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
const buffer=(v:Uint8Array)=>new Uint8Array(v).buffer;
function fields(values:string[]){const result=lengthPrefixed(values);if(!result.ok)return fail();return result.value;}
function point(epub:string){const parsed=parsePrincipalId(epub);if(!parsed.ok)return fail();const [x,y]=epub.split('.');return {kty:'EC',crv:'P-256',x,y};}
function publicPoint(bytes:Uint8Array){if(bytes.length!==65||bytes[0]!==4)return fail();const b64=(v:Uint8Array)=>contactBase64(v).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');return b64(bytes.subarray(1,33))+'.'+b64(bytes.subarray(33));}
function content(value:unknown,now:number):ContactContent{
  const v=value as ContactContent;
  if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join()!=='body,expiresAt,id,issuedAt,kind,v'||v.v!==1||!hex.test(v.id)||
    !['text','grant'].includes(v.kind)||typeof v.body!=='string'||!Number.isSafeInteger(v.issuedAt)||!Number.isSafeInteger(v.expiresAt)||
    v.issuedAt<0||v.issuedAt>now||v.expiresAt<=now||v.expiresAt-v.issuedAt>604800)return fail();
  if(v.kind==='text'){if(contactText(v.body)!==v.body)return fail();}
  else if(!/^(?:[0-9a-f]{2}){94,4096}$/.test(v.body))return fail();
  return {...v};
}
function aad(lane:string,sender:ContactPeer,recipient:ContactPeer){
  if(!hex.test(lane))return fail();
  for(const p of [sender,recipient])for(const key of [p.principal,p.pub,p.epub])if(!parsePrincipalId(key).ok)return fail();
  return fields([domain,lane,sender.principal,sender.pub,recipient.principal,recipient.epub]);
}
function signedBytes(context:Uint8Array,c:ContactContent){return fields([domain,contactBase64(context),c.id,c.kind,String(c.issuedAt),String(c.expiresAt),c.body]);}
async function aes(secret:ArrayBuffer,info:Uint8Array,usage:KeyUsage[]){
  const bytes=new Uint8Array(secret);
  try{const material=await crypto.subtle.importKey('raw',buffer(bytes),'HKDF',false,['deriveKey']);
    return await crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:new Uint8Array(32),info:buffer(info)},material,{name:'AES-GCM',length:256},false,usage);
  }finally{bytes.fill(0);}
}
function authority(expected:ContactPeer,current:()=>ContactPeer){const next=current();if(next.principal!==expected.principal||next.pub!==expected.pub||next.epub!==expected.epub)return fail();}

export async function sealContactMessage(lane:string,pair:SeaPair,senderState:()=>ContactPeer,recipientState:()=>ContactPeer,
  input:ContactContent,clock=()=>Math.floor(Date.now()/1000)){
  const sender={...senderState()},recipient={...recipientState()},held={...pair},c=content(input,clock());
  if(held.pub!==sender.pub||held.epub!==sender.epub)return fail();
  const context=aad(lane,sender,recipient),key=parsePrincipalId(sender.pub);if(!key.ok)return fail();
  const scalar=raw(held.priv);let sig:string;
  try{const result=signWithKeyring(scalar,signedBytes(context,c),key.value);if(!result.ok)return fail();sig=result.value;}finally{scalar.fill(0);}
  const ephemeral=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const peer=await crypto.subtle.importKey('jwk',{...point(recipient.epub),ext:false},{name:'ECDH',namedCurve:'P-256'},false,[]);
  const shared=await crypto.subtle.deriveBits({name:'ECDH',public:peer},ephemeral.privateKey,256);
  const aesKey=await aes(shared,context,['encrypt']),nonce=crypto.getRandomValues(new Uint8Array(12));
  const plain=new TextEncoder().encode(JSON.stringify({content:c,sig}));
  let sealed:ArrayBuffer;
  try{sealed=await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:buffer(context)},aesKey,buffer(plain));}finally{plain.fill(0);}
  const pub=new Uint8Array(await crypto.subtle.exportKey('raw',ephemeral.publicKey));
  authority(sender,senderState);authority(recipient,recipientState);content(c,clock());
  const result=new Uint8Array(78+sealed.byteLength);result[0]=1;result.set(pub,1);result.set(nonce,66);result.set(new Uint8Array(sealed),78);return result;
}

export async function openContactMessage(lane:string,pair:SeaPair,senderState:()=>ContactPeer,recipientState:()=>ContactPeer,
  ciphertext:Uint8Array,clock=()=>Math.floor(Date.now()/1000)):Promise<ContactContent>{
  const sender={...senderState()},recipient={...recipientState()},held={...pair};
  if(held.pub!==recipient.pub||held.epub!==recipient.epub||!(ciphertext instanceof Uint8Array)||ciphertext.length<94||ciphertext.length>16384)return fail();
  const bytes=new Uint8Array(ciphertext);if(bytes[0]!==1)return fail();
  const context=aad(lane,sender,recipient),ephemeral=publicPoint(bytes.subarray(1,66));
  const key=await crypto.subtle.importKey('jwk',{...point(held.epub),d:held.epriv,ext:false},{name:'ECDH',namedCurve:'P-256'},false,['deriveBits']);
  const peer=await crypto.subtle.importKey('jwk',{...point(ephemeral),ext:false},{name:'ECDH',namedCurve:'P-256'},false,[]);
  const shared=await crypto.subtle.deriveBits({name:'ECDH',public:peer},key,256),aesKey=await aes(shared,context,['decrypt']);
  const plain=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.subarray(66,78),additionalData:buffer(context)},aesKey,buffer(bytes.subarray(78))));
  let value:{content:unknown;sig:string};
  try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plain));}finally{plain.fill(0);}
  if(!value||Object.keys(value).sort().join()!=='content,sig'||typeof value.sig!=='string')return fail();
  const c=content(value.content,clock()),signer=parsePrincipalId(sender.pub);if(!signer.ok||!verifyKeySignature(signer.value,value.sig,signedBytes(context,c)).ok)return fail();
  authority(sender,senderState);authority(recipient,recipientState);return c;
}

/** Existing encryption key unlocks ciphertext; this never mints contact secrets. */
export async function contactVaultKey(pair:SeaPair,owner:string){
  if(!parsePrincipalId(owner).ok)return fail();const secret=raw(pair.epriv);if(secret.length!==32)return fail();
  try{return await aes(buffer(secret),fields(['s3rch-contact-vault-v1',owner,pair.epub]),['encrypt','decrypt']);}finally{secret.fill(0);}
}
export async function sealContactVault(key:CryptoKey,owner:string,value:unknown){
  const nonce=crypto.getRandomValues(new Uint8Array(12)),plain=new TextEncoder().encode(JSON.stringify(value));if(plain.length>1048548)return fail();
  try{const sealed=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:buffer(fields(['s3rch-contact-vault-v1',owner]))},key,buffer(plain)));
    const result=new Uint8Array(12+sealed.length);result.set(nonce);result.set(sealed,12);return result;
  }finally{plain.fill(0);}
}
export async function openContactVault(key:CryptoKey,owner:string,encoded:string){
  const bytes=contactBytes(encoded);if(bytes.length<28||bytes.length>1048576)return fail();
  const plain=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:buffer(bytes.subarray(0,12)),additionalData:buffer(fields(['s3rch-contact-vault-v1',owner]))},key,buffer(bytes.subarray(12))));
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plain));}finally{plain.fill(0);}
}
