import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {schnorr} from "@noble/curves/secp256k1.js";
import {createLiveDirectory,verifiedLiveEvent,liveProjection,liveAddress,LIVE_MAX_AGE} from "./nostr-live";
const key=new Uint8Array(32);key[31]=1;
const author=Buffer.from(schnorr.getPublicKey(key)).toString("hex"),now=1800000000;
function signed(overrides:Record<string,unknown>={}){
 const e={pubkey:author,created_at:now,kind:30311,tags:[["d","show"],["status","live"],["streaming","https://example.com/live.m3u8"],["title","A live show"],["image","https://example.com/poster.png"],["current_participants","12"]],content:"",...overrides};
 const hash=createHash("sha256").update(JSON.stringify([0,e.pubkey,e.created_at,e.kind,e.tags,e.content])).digest();
 return {...e,id:hash.toString("hex"),sig:Buffer.from(schnorr.sign(hash,key,new Uint8Array(32))).toString("hex")};
}
test("only bounded authenticated events from followed publishers are admitted",async()=>{
 const valid=signed();assert.ok(await verifiedLiveEvent(valid,[author],now));
 for(const raw of [null,[],{}, {...valid,kind:1},{...valid,pubkey:"b".repeat(64)},{...valid,id:"bad"},{...valid,sig:"bad"},{...valid,sig:"0".repeat(128)},
 {...valid,created_at:now-LIVE_MAX_AGE},{...valid,created_at:now+61},{...valid,created_at:1.5},{...valid,content:"changed"},{...valid,content:"x".repeat(16385)},
 {...valid,content:"\ud800"},{...valid,tags:null},{...valid,tags:Array(129).fill(["d","x"])},{...valid,tags:[[]]},{...valid,tags:[["x",3]]},{...valid,tags:[["x","y".repeat(2049)]]},{...valid,tags:[Array(9).fill("x")]}])assert.equal(await verifiedLiveEvent(raw,[author],now),null);
 assert.equal(await verifiedLiveEvent(valid,[],now),null);
});
test("live projection bounds status, time, URLs and optional metadata",async()=>{
 const e=(await verifiedLiveEvent(signed(),[author],now))!;
 assert.equal(liveProjection(e,now)?.participants,12);assert.equal(liveProjection(e,now)?.thumbnail,"https://example.com/poster.png");
 for(const tags of [[ ["d","show"],["status","ended"] ],[["status","live"]],[["d","show"],["d","other"]]])assert.equal(liveProjection({...e,tags},now),null);
 assert.equal(liveAddress({...e,tags:[["d","x".repeat(257)]]}),null);
 assert.equal(liveProjection(e,now+LIVE_MAX_AGE),null);assert.equal(liveProjection(e,now-61),null);
 const base=[["d","show"],["status","live"],["streaming","https://example.com/live"]];
 for(const extra of [[["starts",String(now+1)]],[["ends",String(now)]],[["streaming","http://127.0.0.1/"]]])assert.equal(liveProjection({...e,tags:[...base,...extra]},now),null);
 const row=liveProjection({...e,tags:[...base,["ends",String(now+20)],["current_participants","9999999999999"]]},now)!;
 assert.equal(row.title,"Live stream");assert.equal(row.expires,now+20);assert.equal(row.participants,undefined);assert.equal(row.thumbnail,undefined);
});
test("shared polling retains ended replacements, refuses replay and expires through failures",async()=>{
 let time=now*1000,calls=0,events:unknown[]=[signed()],fail=false;
 const load=createLiveDirectory([author],async()=>{calls++;if(fail)throw Error("offline");return events;},()=>time);
 const [a,b]=await Promise.all([load(),load()]);assert.equal(calls,1);assert.equal(a.streams.length,1);assert.deepEqual(a,b);
 time+=60_000;events=[signed({created_at:now+60,tags:[["d","show"],["status","ended"]]})];assert.equal((await load()).streams.length,0);
 time+=60_000;events=[signed()];assert.equal((await load()).streams.length,0);
 time+=60_000;events=[signed({created_at:now+180})];assert.equal((await load()).streams.length,1);
 time+=60_000;fail=true;const failed=await load();assert.equal(failed.available,false);assert.equal(failed.streams.length,1);
 time+=(LIVE_MAX_AGE+1)*1000;assert.equal((await load()).streams.length,0);
});
test("invalid events and oversized windows cannot populate the directory",async()=>{
 for(const authors of [[],["bad"],Array(17).fill(author)])assert.throws(()=>createLiveDirectory(authors));
 for(const events of [[null,signed({tags:[]})],Array(101).fill(signed())]){
  const load=createLiveDirectory([author],async()=>events,()=>now*1000);assert.equal((await load()).streams.length,0);
 }
});

test("capacity pressure preserves ended markers instead of admitting older live replays",async()=>{
 let time=now*1000,events:unknown[]=[];
 const load=createLiveDirectory([author],async()=>events,()=>time);
 for(let batch=0;batch<16;batch++){
  events=Array.from({length:100},(_,i)=>signed({tags:[["d",String(batch*100+i)],["status","ended"]]}));
  await load();time+=60_000;
 }
 events=[signed({created_at:now-1,tags:[["d","0"],["status","live"],["streaming","https://example.com/replay"]]}),
  signed({created_at:now+960,tags:[["d","new"],["status","ended"]]})];
 assert.equal((await load()).streams.length,0);
 time=(now+LIVE_MAX_AGE+1)*1000;
 events=[signed({created_at:now+900,tags:[["d","new"],["status","live"],["streaming","https://example.com/replay"]]}),signed({created_at:Math.floor(time/1000)})];
 const fresh=await load();assert.equal(fresh.streams.length,1);assert.ok(fresh.streams[0].id.endsWith(":show"));
});
