import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {publicMediaSnapshot} from "./public-media-snapshot";
test("media admission reads current published snapshot instead of stale process state",()=>{
 const root=mkdtempSync(join(tmpdir(),"public-media-snapshot-"));
 try {
  mkdirSync(join(root,"public/feed-cache"),{recursive:true});const file=join(root,"public/feed-cache/snapshot.json");
  writeFileSync(file,JSON.stringify({items:[{id:"one",source:"rss",media:[{kind:"image",url:"https://example.com/a.png"}]}]}));
  assert.equal(publicMediaSnapshot(root)[0].media?.length,1);
  writeFileSync(file,JSON.stringify({items:[]}));assert.deepEqual(publicMediaSnapshot(root),[]);
  writeFileSync(file,"{}");assert.throws(()=>publicMediaSnapshot(root));
  writeFileSync(file,"x".repeat(8*1024*1024+1));assert.throws(()=>publicMediaSnapshot(root),/large/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
