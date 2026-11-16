import test from 'node:test';
import assert from 'node:assert/strict';
import {createForumMemory,type ForumMemoryState} from './forum-memory';
import {encodeForumCollection,parseForumCollection,forumCollections} from './forum-collections';
import {PILOT_CHAT} from './forum-squad-fixture';
import {seaToPrincipalKey} from './identity/forum-check';
import type {createPrivateMediaBrowser} from './media-browser-session';
const key=PILOT_CHAT[0].author;
const scope={predicate:'same-group' as const,set:`set_${seaToPrincipalKey(key)}_${'a'.repeat(32)}`,label:'Team photos'};
const entry={...scope,object:`media_${seaToPrincipalKey(key)}_${'b'.repeat(32)}`};
test('collection references are bounded canonical navigation, not authority',()=>{
  const body=encodeForumCollection(scope);assert.deepEqual(parseForumCollection(body),scope);
  for(const patch of [{label:''},{label:' x'},{label:'x'.repeat(41)},{label:'\ud800'},{set:'bad'},{predicate:'direct'}])assert.throws(()=>encodeForumCollection({...scope,...patch} as any));
  assert.equal(parseForumCollection(body+' '),null);assert.equal(parseForumCollection('ordinary chat'),null);
  assert.deepEqual(forumCollections([{...PILOT_CHAT[0],body},{...PILOT_CHAT[0],body}]),[scope]);
});
function fixture(){
  let state:ForumMemoryState|undefined,time=100000,allowed=true,linked=true,granted=true,calls=0,opens=0;
  let opening:(()=>Promise<void>)|undefined,reading:(()=>Promise<void>)|undefined;
  const revoked:string[]=[],bytes=new Uint8Array([1,2,3]);
  const browser:typeof createPrivateMediaBrowser=()=>({groupGrantedCatalog:async()=>{calls++;await reading?.();return {at:time/1000,entries:granted?[entry]:[],nextPage:1};},
    openGroup:async()=>{opens++;await opening?.();if(!granted)throw Error('revoked');return {description:{name:'photo.png',mediaType:'image/png'},bytes};}} as any);
  const memory=createForumMemory({key,tenant:'fixture',current:()=>allowed,collections:()=>linked?[scope]:[],changed:next=>{state=next;}},
    {browser,clock:()=>time,makeUrl:()=> 'blob:fixture',revokeUrl:url=>revoked.push(url)});
  return {memory,state:()=>state!,bytes,revoked,calls:()=>calls,opens:()=>opens,setAllowed:(value:boolean)=>{allowed=value;},
    setLinked:(value:boolean)=>{linked=value;},setGranted:(value:boolean)=>{granted=value;},advance:(ms:number)=>{time+=ms;},
    onOpen:(f:()=>Promise<void>)=>{opening=f;},onRead:(f:()=>Promise<void>)=>{reading=f;}};
}
test('forum membership or a signed reference cannot bypass independent catalog/open grants',async()=>{
  const f=fixture();await f.memory.open(entry);assert.equal(f.opens(),0);
  await f.memory.refresh();f.setLinked(false);await f.memory.open(entry);assert.equal(f.opens(),0);
  f.setLinked(true);await f.memory.refresh();f.setGranted(false);await f.memory.open(entry);
  assert.equal(f.state().preview,null);assert.equal(f.opens(),1);f.memory.dispose();
});
test('successful open clears decrypted bytes; revocation and expiry revoke retained previews',async()=>{
  for(const mode of ['grant','forum','link','expiry','dispose']){
    const f=fixture();await f.memory.refresh();await f.memory.open(entry);assert.equal(f.state().preview?.url,'blob:fixture');assert.deepEqual([...f.bytes],[0,0,0]);
    if(mode==='grant'){f.setGranted(false);await f.memory.refresh();}
    if(mode==='forum'){f.setAllowed(false);f.memory.tick();}
    if(mode==='link'){f.setLinked(false);f.memory.tick();}
    if(mode==='expiry'){f.advance(4000);f.memory.tick();}
    if(mode==='dispose')f.memory.dispose();
    assert.equal(f.state().preview,null);assert.deepEqual(f.revoked,['blob:fixture']);f.memory.dispose();
  }
});
test('authority or collection removal during decryption/readback discards plaintext',async()=>{
  for(const mode of ['forum','link','readback']){
    const f=fixture();await f.memory.refresh();
    if(mode==='readback')f.onRead(async()=>{f.setLinked(false);});
    else f.onOpen(async()=>{if(mode==='forum')f.setAllowed(false);else f.setLinked(false);});
    await f.memory.open(entry);assert.equal(f.state().preview,null);assert.deepEqual([...f.bytes],[0,0,0]);f.memory.dispose();
  }
});
test('inactive views do not poll; stale catalogs expire even during a hanging refresh',async()=>{
  const f=fixture();await f.memory.refreshIfLoaded();assert.equal(f.calls(),0);
  await f.memory.refresh();await f.memory.open(entry);
  let finish!:()=>void;f.onRead(()=>new Promise<void>(resolve=>{finish=resolve;}));
  const pending=f.memory.refresh();f.advance(4000);f.memory.tick();assert.equal(f.state().preview,null);
  finish();await pending;assert.equal(f.state().loaded,false);assert.deepEqual(f.revoked,['blob:fixture']);f.memory.dispose();
});
