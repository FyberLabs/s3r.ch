import {parsePrincipalId} from 'sociacl-ids';
import type {FirstContactStore,Descriptor,Row} from 'sociacl-ids/first-contact-store';
import type {VerifiedFirstContact} from 'sociacl-ids/first-contact';
import {contactBase64,contactBytes} from './contact-document-client';
import type {ContactVault,ContactVaultStore} from './contact-vault';
const hex=(v:unknown,n=64):v is string=>typeof v==='string'&&v.length===n&&/^[0-9a-f]+$/.test(v);
const integer=(v:number)=>Number.isSafeInteger(v)&&v>=0;
const random=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
const fail=():never=>{throw Error('Contact journal changed');};
function match(v:ContactVault,d:Descriptor|null,now:number){
 const active=v.journal.descriptor;
 if(!v.journal.enabled||!active||now>=active.expiresAt||!d||Object.keys(d).length!==6||
   (['channelId','revision','encryptionEpub','expiresAt','maxLifetimeSeconds','maxMessageBytes'] as const).some(k=>d[k]!==active[k]))return fail();
}
function row(value:ContactVault['journal']['rows'][number]):Row{return {...structuredClone(value),envelope:contactBytes(value.envelope)};}
/** Remote CAS plus the source's complete-history fence supplies the atomic
 * decision boundary. The synchronous validator runs before and after sealing;
 * backend admission checks the same history fence while holding the write lock. */
export function contactJournal(vault:ContactVaultStore,signal:AbortSignal,selected?:VerifiedFirstContact):FirstContactStore{
 let closed=false;
 const guard=()=>{vault.guard(signal);if(closed)return fail();};
 async function read(){guard();const {value}=await vault.load(signal);guard();if(!value)return fail();return value;}
 return {owner:vault.owner,
  async activate(input){
   guard();return vault.change((v,now)=>{
    if(!input||!parsePrincipalId(input.encryptionEpub).ok||!integer(input.expiresAt)||input.expiresAt<=now||input.expiresAt-now>604800||
      !integer(input.maxLifetimeSeconds)||input.maxLifetimeSeconds<1||input.maxLifetimeSeconds>604800||!integer(input.maxMessageBytes)||input.maxMessageBytes<1||input.maxMessageBytes>4096||v.journal.revision>=Number.MAX_SAFE_INTEGER)return fail();
    const d={channelId:random(),revision:v.journal.revision+1,...input};v.journal.revision=d.revision;v.journal.enabled=true;v.journal.descriptor=d;return structuredClone(d);
   },signal,guard);
  },
  async disable(){guard();await vault.change(v=>{v.journal.enabled=false;},signal,guard);},
  async descriptor(){const v=await read();match(v,v.journal.descriptor,vault.state(vault.owner).context.now);return structuredClone(v.journal.descriptor!);},
  async reserve(descriptor,record){
   const d=structuredClone(descriptor),r={...record,envelope:new Uint8Array(record.envelope)};guard();
   return vault.change((v,now)=>{
    match(v,d,now);
    if(!hex(r.replayKey)||!hex(r.requestId)||r.replayUntil!==d.expiresAt||!integer(r.expiresAt)||r.expiresAt<=now||r.expiresAt>r.replayUntil||r.envelope.length<94||r.envelope.length>8192)return fail();
    if(v.journal.rows.some(row=>row.replayKey===r.replayKey))return false;
    if(v.journal.rows.length>=256)return fail();
    v.journal.rows.push({...r,envelope:contactBase64(r.envelope),revision:d.revision,status:'pending'});return true;
   },signal,()=>{guard();if(vault.state(vault.owner).context.now>=Math.min(d.expiresAt,r.expiresAt))return fail();});
  },
  async pending(expected){const v=await read(),now=vault.state(vault.owner).context.now;match(v,expected??v.journal.descriptor,now);
   return v.journal.rows.filter(r=>r.revision===v.journal.revision&&r.status==='pending'&&r.expiresAt>now).map(row);},
  async decide(descriptor,replayKey,requestId,decision,validateAuthority){
   const d=structuredClone(descriptor),picked=structuredClone(decision),verified=selected?structuredClone(selected):undefined;guard();
   let until=d.expiresAt;
   const validate=()=>{guard();if(vault.state(vault.owner).context.now>=until)return fail();if(validateAuthority&&validateAuthority()!==undefined)return fail();};
   await vault.change((v,now)=>{
    match(v,d,now);const r=v.journal.rows.find(r=>r.replayKey===replayKey);
    if(!r||!hex(replayKey)||!hex(requestId)||r.requestId!==requestId||r.revision!==d.revision||r.status!=='pending'||r.expiresAt<=now)return fail();until=Math.min(until,r.expiresAt);
    if(picked.status==='accepted'){
     if(!verified||verified.requestId!==requestId||verified.replayKey!==replayKey||!integer(picked.rotationSeq)||
       !hex(picked.ciphertextHex,picked.ciphertextHex.length)||picked.ciphertextHex.length<188||picked.ciphertextHex.length>8192||picked.ciphertextHex.length%2)return fail();
     const peer=v.contacts.find(p=>p.principal===verified.request.sender);if(peer?.blocked)return fail();
     if(!peer){if(v.contacts.length>=64)return fail();v.contacts.push({principal:verified.request.sender,blocked:false});}
     r.verified=verified;r.grant={ciphertextHex:picked.ciphertextHex,rotationSeq:picked.rotationSeq};
    }else if(picked.status!=='rejected')return fail();
    validate();r.status=picked.status;
   },signal,validate);
  },
  async outbox(){return (await read()).journal.rows.filter(r=>r.status==='accepted').map(row);},
  async acknowledge(replayKey,requestId,ciphertextHex){guard();await vault.change(v=>{
   const r=v.journal.rows.find(r=>r.replayKey===replayKey);if(!r||r.requestId!==requestId||r.status!=='accepted'||r.grant?.ciphertextHex!==ciphertextHex)return fail();
   r.status='delivered';delete r.grant;
  },signal,guard);},
  close(){closed=true;},
 };
}
