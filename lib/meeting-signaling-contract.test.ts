import test from 'node:test';
import assert from 'node:assert/strict';
import keys from './identity/vectors/forums.json';
import {parseMeetingLease,parseMeetingFrame,createMeetingFrameSequence} from './meeting-signaling-contract';
const a=keys.seaPubkey,b=keys.secondPubkey;
const lease=()=>({v:1,tenant:'11111111-1111-4111-8111-111111111111',room:'room-fixture',meeting:'a'.repeat(32),generation:'b'.repeat(32),
  issuedAt:1000,expiresAt:31000,participants:[{principal:a,key:a,session:'c'.repeat(32)},{principal:b,key:b,session:'d'.repeat(32)}],offerer:a});
const frame=(seq=1)=>({v:1,tenant:lease().tenant,room:lease().room,meeting:lease().meeting,generation:lease().generation,
  from:a,to:b,key:a,session:'c'.repeat(32),seq,kind:'offer',body:'v=0\r\n'});
const candidate=(seq:number)=>({...frame(seq),kind:'candidate',body:{candidate:'candidate:synthetic',sdpMid:'0',sdpMLineIndex:0,usernameFragment:null}});
test('lease snapshots bind exactly two distinct current keys and bounded session lifetime',()=>{
  const raw=lease(),held=parseMeetingLease(raw,1000);raw.participants[0].session='e'.repeat(32);
  assert.equal(held.participants[0].session,'c'.repeat(32));assert.ok(Object.isFrozen(held.participants));
  for(const patch of [{expiresAt:31001},{issuedAt:1001},{expiresAt:1000},{tenant:'bad'},{room:'x\n'},
    {participants:[lease().participants[0],lease().participants[0]]},{offerer:'unknown'},{extra:'token'}])
    assert.throws(()=>parseMeetingLease({...lease(),...patch},1000));
  const accessor=lease();let invoked=false;Object.defineProperty(accessor.participants,0,{get(){invoked=true;return lease().participants[0];}});
  assert.throws(()=>parseMeetingLease(accessor,1000));assert.equal(invoked,false);
});
test('cross-room, meeting, generation, identity, role and oversized frames fail without echoing payload',()=>{
  const held=parseMeetingLease(lease(),1000);assert.equal(parseMeetingFrame(frame(),held,1000).kind,'offer');
  for(const patch of [{tenant:'22222222-2222-4222-8222-222222222222'},{room:'other'},{meeting:'e'.repeat(32)},
    {generation:'f'.repeat(32)},{key:b},{session:'e'.repeat(32)},{to:a},{kind:'answer'},
    {seq:0},{seq:4097},{body:'sensitive'.repeat(10000)},{token:'secret'}])
    assert.throws(()=>parseMeetingFrame({...frame(),...patch},held,1000),/^Error: Invalid meeting signaling contract$/);
  assert.throws(()=>parseMeetingFrame({...frame(),body:'\n'.repeat(60000)},held,1000));
  assert.throws(()=>parseMeetingFrame({...candidate(2),body:{...candidate(2).body,candidate:'x'.repeat(2049)}},held,1000));
});
test('ordered delivery rejects gaps and replays, preserves cursor and bounds negotiation',()=>{
  const held=parseMeetingLease(lease(),1000),receiver=createMeetingFrameSequence(held,b,1000);
  assert.throws(()=>receiver.accept(candidate(1),1000));
  assert.throws(()=>receiver.accept(candidate(2),1000));
  assert.equal(receiver.accept(frame(),1000)?.seq,1);assert.equal(receiver.accept(frame(),1000),null);
  assert.throws(()=>receiver.accept({...frame(),body:'different'},1000));
  assert.throws(()=>receiver.accept(candidate(3),1000));assert.equal(receiver.accept(candidate(2),1000)?.seq,2);
  assert.throws(()=>receiver.accept(frame(),1000));assert.throws(()=>receiver.accept(frame(3),1000));
  assert.equal(receiver.accept({...frame(3),kind:'end',body:null},1000)?.seq,3);
  assert.throws(()=>receiver.accept(candidate(4),1000));
  assert.equal(receiver.accept({...frame(4),kind:'leave',body:null},1000)?.kind,'leave');
  assert.throws(()=>receiver.accept(candidate(5),1000));
});
test('expiry, clock rollback and explicit revocation close the sequence permanently',()=>{
  for(const stop of ['expiry','rollback','close']){
    const receiver=createMeetingFrameSequence(parseMeetingLease(lease(),1000),b,1000);
    receiver.accept(frame(),2000);
    if(stop==='close')receiver.close();else assert.throws(()=>receiver.accept(candidate(2),stop==='expiry'?31000:1999));
    assert.throws(()=>receiver.accept(candidate(2),2001));
  }
});
test('recipient replacement and wrong recipient cannot reuse an old sequence',()=>{
  const held=parseMeetingLease(lease(),1000),receiver=createMeetingFrameSequence(held,a,1000);
  assert.throws(()=>receiver.accept(frame(),1000));
  const replaced=lease();replaced.generation='e'.repeat(32);replaced.participants[1].session='f'.repeat(32);
  assert.throws(()=>parseMeetingFrame(frame(),parseMeetingLease(replaced,1000),1000));
});
