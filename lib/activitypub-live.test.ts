import { test } from "node:test";
import assert from "node:assert/strict";
import { activityPubLiveProjection, createActivityPubLiveDirectory, pullActivityPubLive } from "./activitypub-live";

const actor = "https://video.example/accounts/alice", id = "https://video.example/videos/watch/live";
const now = 1800000000, audience = "https://www.w3.org/ns/activitystreams#Public";
const video = () => ({ id, type: "Video", attributedTo: [{ type: "Person", id: actor }], to: [audience],
  isLiveBroadcast: true, state: 1, sensitive: false, name: "Live fixture", views: 123456,
  permanentLive: true, published: "2020-01-01T00:00:00Z" });
const activity = (object: unknown = id) => ({ type: "Create", actor, object });
function fixture() {
  return new Map<string, unknown>([
    [actor, { id: actor, type: "Person", outbox: actor + "/outbox" }],
    [actor + "/outbox", { type: "OrderedCollection", first: actor + "/outbox?page=1" }],
    [actor + "/outbox?page=1", { type: "OrderedCollectionPage", orderedItems: [activity()] }],
    [id, video()],
  ]);
}

test("current public canonical Video projects an external link without fabricated start or viewers", () => {
  const stream = activityPubLiveProjection(video(), actor, id, now)!;
  assert.equal(stream.url, id); assert.equal(stream.playback, "external");
  assert.equal(stream.timeBasis, "observed"); assert.equal(stream.starts, now);
  assert.equal(stream.expires, now + 300); assert.equal(stream.participants, undefined);
  assert.equal(stream.thumbnail, undefined);
});

test("ended, waiting, replay, private, sensitive and foreign-author videos stay hidden", () => {
  for (const patch of [{state: 4}, {state: 5}, {state: "1"}, {isLiveBroadcast: false},
    {to: []}, {sensitive: true}, {sensitive: undefined}, {tag: [{type: "SensitiveTag"}]},
    {attributedTo: "https://video.example/accounts/bob"}, {id: id + "other"}, {type: "Note"}]) {
    assert.equal(activityPubLiveProjection({...video(), ...patch}, actor, id, now), null);
  }
  assert.equal(activityPubLiveProjection(video(), actor, "https://foreign.example/live", now), null);
});

test("discovery refetches canonical objects and never trusts embedded live state", async () => {
  const data = fixture(), calls: string[] = [];
  data.set(actor + "/outbox?page=1", {type: "OrderedCollectionPage", orderedItems: [activity(video())]});
  data.set(id, {...video(), state: 5});
  assert.deepEqual(await pullActivityPubLive(actor, async url => {calls.push(url); return data.get(url);}, () => now*1000), []);
  assert.deepEqual(calls, [actor, actor + "/outbox", actor + "/outbox?page=1", id]);
  data.set(actor + "/outbox?page=1", {type: "OrderedCollectionPage", orderedItems: [{...activity(),type:"Announce"}]});
  data.set(id, video());
  assert.equal((await pullActivityPubLive(actor, async url => data.get(url), () => now*1000)).length, 1);
});

test("actor, outbox and first-page authority are enforced before additional fetches", async () => {
  for (const [key, value, count] of [
    [actor, {id: actor + "wrong", type:"Person", outbox:actor+"/outbox"}, 1],
    [actor, {id: actor, type:"Person", outbox:"https://foreign.example/outbox"}, 1],
    [actor+"/outbox", {type:"OrderedCollection",first:"http://127.0.0.1/"}, 2],
    [actor+"/outbox", {type:"Other",orderedItems:[]}, 2],
    [actor+"/outbox?page=1", {type:"OrderedCollectionPage",next:actor+"/more"}, 3],
  ] as const) {
    const data=fixture();data.set(key,value);let calls=0;
    await assert.rejects(pullActivityPubLive(actor,async url=>{calls++;return data.get(url);},()=>now*1000));
    assert.equal(calls,count);
  }
});

test("discovery bounds its source window, canonical fetches and elapsed budget", async () => {
  const data=fixture(),calls:string[]=[];
  data.set(actor+"/outbox",{type:"OrderedCollection",orderedItems:[
    {...activity(),actor:"https://foreign.example/actor"},activity("https://foreign.example/video"),
    ...Array.from({length:30},(_,i)=>activity(id+i)),
  ]});
  await pullActivityPubLive(actor,async url=>{calls.push(url);return data.get(url);},()=>now*1000);
  assert.equal(calls.length,6); // actor, outbox, four canonical candidates
  let time=now*1000;
  await assert.rejects(pullActivityPubLive(actor,async url=>{time+=30_000;return data.get(url);},()=>time));
});

test("polls coalesce; ended observations remove entries and failures cannot extend expiry", async () => {
  const data=fixture();let time=now*1000,calls=0,fail=false;
  const read=createActivityPubLiveDirectory([actor],async url=>{calls++;if(fail)throw Error("offline");return data.get(url);},()=>time);
  const [a,b]=await Promise.all([read(),read()]);assert.deepEqual(a,b);assert.equal(calls,4);
  assert.equal(a.streams.length,1);
  data.set(id,{...video(),state:5});time+=60_000;
  assert.deepEqual(await read(),{available:true,streams:[]});
  data.set(id,video());time+=60_000;await read();fail=true;time+=60_000;
  assert.equal((await read()).streams[0].expires,now+420);
  time=(now+420)*1000;assert.deepEqual(await read(),{available:false,streams:[]});
});

test("missing sources and empty windows stay empty; source configuration is bounded", async () => {
  assert.throws(()=>createActivityPubLiveDirectory([actor,actor]));
  assert.throws(()=>createActivityPubLiveDirectory(Array(5).fill(actor)));
  for(const invalid of ["http://video.example/a","https://localhost/a","https://user:pass@video.example/a","bad"])
    assert.throws(()=>createActivityPubLiveDirectory([invalid]));
  assert.deepEqual(await createActivityPubLiveDirectory([],async()=>{throw Error("unexpected");})(),{available:false,streams:[]});
  const data=fixture();data.set(actor+"/outbox",{type:"OrderedCollection",totalItems:0});
  assert.deepEqual(await pullActivityPubLive(actor,async url=>data.get(url),()=>now*1000),[]);
});
