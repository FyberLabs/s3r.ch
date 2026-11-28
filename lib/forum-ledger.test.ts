import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {encodeLedgerEntry,parseLedgerEntry,ledgerEntries,LEDGER_PREFIX} from './forum-ledger';
import {readableForumChat} from './forum-readable-chat';
import {PILOT_CHAT,PILOT_FORUM_ID} from './identity/vectors/forum-squad-fixture';
import {ForumLedger} from '../components/ForumLedger';
import {ForumShell} from '../components/ForumShell';
import {publishBrowserForumRecord} from './identity/browser-forum-signer';
import {buildForumStatement} from './forum-squad';
import {seaToPrincipalKey} from './identity/forum-check';
import {toGunNode} from './feed-types';
import type {SeaPair} from './identity/sea';

test('ledger statements are signed by the author and permission loss prevents a put',async()=>{
  const {createRequire}=await import('node:module');
  const sea=createRequire(import.meta.url)('gun/sea');
  const pair:SeaPair=await sea.pair();
  const body=encodeLedgerEntry({kind:'decision',text:'Review before release',owner:pair.pub});
  const item=buildForumStatement({forumId:`forum_${seaToPrincipalKey(pair.pub)}_${'a'.repeat(32)}`,author:pair.pub,body,now:100,entropy:'b'.repeat(32)});
  assert.ok(item);const record=toGunNode(item);let signature='',puts=0,allowed=true;
  const input={live:true,record,writer:pair.pub,pair:()=>pair,writerKey:()=>pair.pub,authorized:()=>allowed,
    put:(value:typeof record & {sig:string})=>{signature=value.sig;puts++;return true;}};
  assert.equal(await publishBrowserForumRecord(input),'signed');
  assert.deepEqual(await sea.verify(signature,pair.pub),record);
  assert.equal(parseLedgerEntry((await sea.verify(signature,pair.pub)).body)?.text,'Review before release');
  allowed=false;assert.equal(await publishBrowserForumRecord(input),'denied');assert.equal(puts,1);
});

test('ledger entries have a canonical bounded format and cannot grant authority',()=>{
  for(const kind of ['decision','work'] as const){
    const entry={kind,text:'Follow up with the owner',owner:null};
    assert.deepEqual(parseLedgerEntry(encodeLedgerEntry(entry)),entry);
  }
  for(const text of ['', ' padded', 'a'.repeat(121), '\ud800', 'line\nbreak'])
    assert.throws(()=>encodeLedgerEntry({kind:'work',text,owner:null}));
  assert.throws(()=>encodeLedgerEntry({kind:'work',text:'Work',owner:'not a SEA key'}));
  for(const body of ['ordinary chat',LEDGER_PREFIX+'["work","Work",null,"admin"]',LEDGER_PREFIX+'["work", "Work",null]',
    LEDGER_PREFIX+'["grant","Work",null]',LEDGER_PREFIX+'null']) assert.equal(parseLedgerEntry(body),null);
});

test('ledger projection loses entries immediately when proof, reader or author authority is lost',()=>{
  const base=PILOT_CHAT[0],row={...base,body:encodeLedgerEntry({kind:'work',text:'Review the plan',owner:base.author})};
  let proven=true,member=true,author=true;
  // Authority graph is a test double; cryptographic admission is covered by the
  // existing forum statement and signed publication contracts.
  const graph={principalForKey:(key:string)=>key==='session'?'reader':null,
    checkForumSee:()=>({allowed:member,reason:'fixture'}),checkDirectSee:()=>({allowed:author,reason:'fixture'}),
    checkPost:()=>({allowed:author,reason:'fixture'})};
  const read=(session:string|null='session')=>ledgerEntries(readableForumChat([row],PILOT_FORUM_ID,session,graph,()=>proven,100));
  assert.equal(read()[0].author,row.author);assert.equal(read()[0].owner,row.author);
  assert.deepEqual(read(null),[]);assert.deepEqual(read('old-session'),[]);
  proven=false;assert.deepEqual(read(),[]);proven=true;
  member=false;assert.deepEqual(read(),[]);member=true;
  author=false;assert.deepEqual(read(),[]);
});

test('memory tab mounts the supplied ledger, escapes content and does not mount roster views',()=>{
  const ledger=createElement(ForumLedger,{writable:true,rows:[{...PILOT_CHAT[0],body:encodeLedgerEntry({kind:'decision',text:'<script>not markup</script>',owner:null})}],send:async()=>false});
  const forbidden=()=>{throw Error('roster mounted');};
  const html=renderToStaticMarkup(createElement(ForumShell,{forum:{label:'Forum',href:'/feed/squad'},tab:'memory',onTab:()=>{},
    header:null,sidebar:null,controls:createElement(forbidden),board:createElement(forbidden),list:createElement(forbidden),chat:null,memory:ledger}));
  assert.match(html,/Business ledger/);assert.match(html,/&lt;script&gt;/);assert.equal(html.includes('<script>'),false);
  assert.match(html,/Add signed entry/);assert.doesNotMatch(html,/No shared memory/);
});
