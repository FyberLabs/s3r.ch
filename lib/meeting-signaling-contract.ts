/** Inactive consumer contract proposal for #527. Shape and binding validation
 * cannot authenticate a service, establish Check see, or mint MeetingAuthority. */
import {isSeaPubkey} from './identity/forum-check';
export const MEETING_LEASE_MS=30000,MEETING_FRAME_BYTES=98304,MEETING_SEQUENCE_MAX=4096;
type Participant=Readonly<{principal:string;key:string;session:string}>;
export type MeetingLease=Readonly<{v:1;tenant:string;room:string;meeting:string;generation:string;
  issuedAt:number;expiresAt:number;participants:readonly [Participant,Participant];offerer:string}>;
type Candidate=Readonly<{candidate:string;sdpMid:string|null;sdpMLineIndex:number|null;usernameFragment:string|null}>;
export type MeetingFrame=Readonly<{v:1;tenant:string;room:string;meeting:string;generation:string;
  from:string;to:string;key:string;session:string;seq:number;kind:'offer'|'answer'|'candidate'|'end'|'leave';body:string|Candidate|null}>;
const fail=():never=>{throw Error('Invalid meeting signaling contract');};
function fields(input:unknown,names:string[]):Record<string,unknown>{
  if(!input||typeof input!=='object'||Array.isArray(input))return fail();
  const keys=Reflect.ownKeys(input);if(keys.length!==names.length||keys.some(k=>typeof k!=='string'||!names.includes(k)))return fail();
  const result:Record<string,unknown>={};
  for(const name of names){const d=Object.getOwnPropertyDescriptor(input,name);if(!d||!('value' in d))return fail();result[name]=d.value;}
  return result;
}
const integer=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&!Object.is(v,-0);
const opaque=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{32}$/.test(v);
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&v.isWellFormed()&&!v.includes('\0')&&new TextEncoder().encode(v).length<=max;
export function parseMeetingLease(input:unknown,now:number):MeetingLease{
  const v=fields(input,['v','tenant','room','meeting','generation','issuedAt','expiresAt','participants','offerer']);
  if(v.v!==1||typeof v.tenant!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v.tenant)||
    !text(v.room,512)||v.room.trim()!==v.room||/[\u0000-\u001f\u007f]/u.test(v.room)||!opaque(v.meeting)||!opaque(v.generation)||
    !integer(now)||!integer(v.issuedAt)||!integer(v.expiresAt)||v.issuedAt>now||v.expiresAt<=now||
    v.expiresAt-v.issuedAt>MEETING_LEASE_MS||!Array.isArray(v.participants)||v.participants.length!==2)return fail();
  if(Reflect.ownKeys(v.participants).length!==3)return fail();
  const participantRows=[0,1].map(index=>{const d=Object.getOwnPropertyDescriptor(v.participants,index);if(!d||!("value" in d))return fail();return d.value;});
  const participants=participantRows.map(raw=>{
    const p=fields(raw,['principal','key','session']);
    if(typeof p.principal!=='string'||!isSeaPubkey(p.principal)||typeof p.key!=='string'||!isSeaPubkey(p.key)||!opaque(p.session))return fail();
    return Object.freeze(p) as Participant;
  }) as [Participant,Participant];
  if(participants[0].principal===participants[1].principal||participants[0].key===participants[1].key||!participants.some(p=>p.principal===v.offerer))return fail();
  return Object.freeze({...v,participants:Object.freeze(participants)}) as MeetingLease;
}
export function parseMeetingFrame(input:unknown,expected:MeetingLease,now:number):MeetingFrame{
  const lease=parseMeetingLease(expected,now),v=fields(input,['v','tenant','room','meeting','generation','from','to','key','session','seq','kind','body']);
  if(v.v!==1||v.tenant!==lease.tenant||v.room!==lease.room||v.meeting!==lease.meeting||v.generation!==lease.generation||
    !integer(v.seq)||v.seq<1||v.seq>MEETING_SEQUENCE_MAX)return fail();
  const sender=lease.participants.find(p=>p.principal===v.from),recipient=lease.participants.find(p=>p.principal===v.to);
  if(!sender||!recipient||sender===recipient||sender.key!==v.key||sender.session!==v.session)return fail();
  if(v.kind==='offer'||v.kind==='answer'){
    if((v.kind==='offer')!==(v.from===lease.offerer)||!text(v.body,65536))return fail();
  }else if(v.kind==='candidate'){
    const c=fields(v.body,['candidate','sdpMid','sdpMLineIndex','usernameFragment']);
    if(!text(c.candidate,2048)||(c.sdpMid!==null&&!text(c.sdpMid,64))||
      (c.sdpMLineIndex!==null&&(!integer(c.sdpMLineIndex)||c.sdpMLineIndex>255))||
      (c.usernameFragment!==null&&!text(c.usernameFragment,256)))return fail();
    v.body=Object.freeze(c);
  }else if((v.kind!=='end'&&v.kind!=='leave')||v.body!==null)return fail();
  if(new TextEncoder().encode(JSON.stringify(v)).length>MEETING_FRAME_BYTES)return fail();
  return Object.freeze(v) as MeetingFrame;
}
/** One ordered remote sender, bounded to one retained frame. The caller must
 * authenticate each delivery and check current admission before invoking this.
 * A duplicate of the last exact frame is a no-op; gaps never advance progress. */
export function createMeetingFrameSequence(input:MeetingLease,recipient:string,now:number){
  const lease=parseMeetingLease(input,now);
  if(!lease.participants.some(p=>p.principal===recipient))return fail();
  let last=0,lastTime=now,lastFrame='',closed=false,description=false,ended=false;
  const close=()=>{closed=true;lastFrame='';};
  return {accept(raw:unknown,time:number):MeetingFrame|null{
    if(closed)return fail();
    if(time<lastTime){close();return fail();}
    if(time>=lease.expiresAt){close();return fail();}
    const frame=parseMeetingFrame(raw,lease,time);if(frame.to!==recipient)return fail();
    lastTime=time;const canonical=JSON.stringify(frame);
    if(frame.seq===last&&canonical===lastFrame)return null;
    if(frame.seq!==last+1)return fail();
    if(frame.kind==='offer'||frame.kind==='answer'){if(description)return fail();description=true;}
    else if(frame.kind==='candidate'||frame.kind==='end'){if(!description||ended)return fail();if(frame.kind==='end')ended=true;}
    last=frame.seq;lastFrame=canonical;if(frame.kind==='leave')close();return frame;
  },close};
}
