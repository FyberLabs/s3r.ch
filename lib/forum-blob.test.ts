import assert from 'node:assert/strict';
import test from 'node:test';
import { BlobForumStore, FORUM_BLOB, migrateForum } from './forum-blob';
import { emptyForumFile, openForum, handleForumPost } from './forum';
import { blobConflict, type IdentityBlobClient } from '../identity-blob.cjs';
const owner = 'PtETt4g7TFkGODedsMIc2hZ0LtAlUEi_QzOR03S8IdE.kJkgmszEyKIkyEOvpPTGigkNBNpemIna4vju_OgqN0A';
const other = 'dB3VvagX2V5GJlNzIOXVUXmYMCiy-CyZ1QDF7oYk48Q.B3C0apw4X9xWc4NVSIexVI7rkSw1ulynGZX_Is1EgdM';
function fixture() {
  let text: string | null = null, version = 0;
  const client: IdentityBlobClient = {
    assertReachable() {},
    download(name) { assert.equal(name, FORUM_BLOB); return text === null ? {found:false} : {found:true,text,etag:String(version)}; },
    upload(name, next, conditions) {
      assert.equal(name, FORUM_BLOB);
      if ((conditions.ifNoneMatch === '*' && text !== null) || (conditions.ifMatch !== undefined && conditions.ifMatch !== String(version))) throw blobConflict();
      assert.ok(conditions.ifMatch !== undefined || conditions.ifNoneMatch === '*');
      text = next; return {etag:String(++version)};
    },
  };
  return {client, read:()=>text, corrupt:(next:string)=>{text=next;version++;}};
}
test('migration is create-only, preserves the ledger and never repairs missing/corrupt state', () => {
  const f=fixture(), store=new BlobForumStore(f.client);
  assert.equal(store.load().ok,false); assert.equal(f.read(),null);
  assert.throws(()=>store.save(emptyForumFile()));
  migrateForum(f.client,emptyForumFile()); const before=f.read();
  assert.throws(()=>migrateForum(f.client,emptyForumFile()), /conflict/);
  assert.equal(f.read(),before);
  f.corrupt('{broken'); assert.equal(store.load().ok,false); assert.throws(()=>store.save(emptyForumFile()));
  assert.equal(f.read(),'{broken');
});
test('two processes cannot overwrite each other; a fresh read permits the next write', () => {
  const f=fixture();migrateForum(f.client,emptyForumFile());
  const a=new BlobForumStore(f.client), b=new BlobForumStore(f.client);
  const first=a.load(), stale=b.load();assert.ok(first.ok && stale.ok);
  a.save(first.file); const accepted=f.read();
  assert.throws(()=>b.save(stale.file), /conflict/);assert.equal(f.read(),accepted);
  const fresh=b.load();assert.ok(fresh.ok);b.save(fresh.file);
});
test('HTTP mutations expose conflicts as retryable 409 without falsely accepting a write', () => {
  const f=fixture();migrateForum(f.client,emptyForumFile());
  const client={...f.client,upload:()=>{throw blobConflict();}};
  const response=handleForumPost(openForum(new BlobForumStore(client)),owner,{action:'register',label:'one',entropy:'aa11'});
  assert.equal(response.status,409);assert.equal(response.body.reason,'store-conflict');
});
test('ledger and private snapshot survive a color change and retain authorization', () => {
  const f=fixture();migrateForum(f.client,emptyForumFile());
  const first=openForum(new BlobForumStore(f.client));
  assert.ok(!('denied' in first.registerBot({owner,label:'one',entropy:'aa11'})));
  const bytes=Buffer.from('snapshot unit fixture');
  const result=first.publishDesktop({owner,session:'11111111-1111-4111-8111-111111111111',
    snapshot:{handle:'abc123def0',mime:'image/png',seq:1},thinking:[],files:[],secrets:[],pngBase64:bytes.toString('base64')});
  assert.ok(!('denied' in result));
  const restarted=openForum(new BlobForumStore(f.client));
  assert.deepEqual(restarted.readSnapshot({owner,handle:'abc123def0'})?.bytes,bytes);
  assert.equal(restarted.readSnapshot({owner:other,handle:'abc123def0'}),null);
});
test('oversize mutation leaves the prior document intact', () => {
  const f=fixture();migrateForum(f.client,emptyForumFile());const store=new BlobForumStore(f.client);
  const value=store.load();assert.ok(value.ok);const before=f.read();
  assert.throws(()=>store.save(value.file,{channel:'test',handle:'test',bytes:Buffer.alloc(1048576)}),/capacity|quota/);
  assert.equal(f.read(),before);
});
test('one owner cannot exhaust the shared document and cleanup still works at its quota', () => {
  const f=fixture();migrateForum(f.client,emptyForumFile());const forum=openForum(new BlobForumStore(f.client));
  const bots: string[]=[];
  for(let i=0;i<16;i++) {
    const result=forum.registerBot({owner,label:`bot${i}`,entropy:`b${i}`});
    assert.ok(!('denied' in result));bots.push(result.bot.id);
  }
  assert.deepEqual(forum.registerBot({owner,label:'excess',entropy:'excess'}),{denied:true,reason:'store-quota'});
  assert.ok(!('denied' in forum.registerBot({owner:other,label:'other',entropy:'other'})));
  assert.ok(!('denied' in forum.archiveBot({owner,botId:bots[0]})));
  assert.deepEqual(forum.registerBot({owner:other,label:'huge',entropy:'a'.repeat(65)}),{denied:true,reason:'bad-entropy'});
});
