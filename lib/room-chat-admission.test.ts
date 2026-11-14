import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { createRoomChatAdmission } from "./room-chat-admission";
import { admittedRoomTasks } from "./room-tasks";
import { encodeKey } from "./identity/check";
import type { ForumAuthorityGraph } from "./identity/forum-authority";
import type { SeaPair } from "./identity/sea";
const TASK_PREFIX="s3rch-work:v1:";
const sea=createRequire(import.meta.url)("gun/sea") as {pair():Promise<SeaPair>};
// Unit contract substitutes the already-verified authority graph, not signature verification.
async function fixture(){
 const alice=await sea.pair(),bob=await sea.pair();let access=true;
 const keys=new Set([alice.pub,bob.pub]);
 const graph={writerKey:(p:string)=>keys.has(p)?p:null,principalForKey:(p:string)=>keys.has(p)?p:null,
  checkForumSee:()=>({allowed:access}),checkPost:()=>({allowed:access})} as unknown as ForumAuthorityGraph;
 const admission=createRoomChatAdmission({graph,readerKey:()=>alice.pub,clock:()=>100});
 return {alice,bob,admission,keys,revoke:()=>{access=false;}};
}
test("signed chat binds author, payload, transport ID and room; unsigned rows are refused",async()=>{
 const f=await fixture();const row=await f.admission.compose("room","hello",()=>f.alice);assert.ok(row);
 assert.ok(await f.admission.receive(row,"room",encodeKey(row.id)));
 for(const changed of [{...row,author:f.bob.pub},{...row,body:"forged"},{...row,id:"s3rch:chat:"+"a".repeat(32)},{...row,sig:undefined}])
  assert.equal(await f.admission.receive(changed,"room",encodeKey(changed.id)),null);
 assert.equal(await f.admission.receive(row,"elsewhere",encodeKey(row.id)),null);
 assert.equal(await f.admission.receive(row,"room","wrong"),null);
 assert.equal(f.admission.valid({...row}),false);
 f.revoke();assert.equal(f.admission.valid(row),false);assert.equal(await f.admission.compose("room","hidden",()=>f.alice),null);
});
test("only verified creators update tasks and revocation removes the projection",async()=>{
 const f=await fixture();const create=await f.admission.compose("room",TASK_PREFIX+JSON.stringify(["create","task","Review","room","open",null]),()=>f.alice);assert.ok(create);
 const outsider=await f.admission.compose("room",TASK_PREFIX+JSON.stringify(["status",create.id,create.id,"done"]),()=>f.bob);assert.ok(outsider);
 assert.equal(admittedRoomTasks([create,outsider],"room",f.admission)[0].status,"open");
 assert.deepEqual(admittedRoomTasks([{...create}],"room",f.admission),[]);
 f.revoke();assert.deepEqual(admittedRoomTasks([create],"room",f.admission),[]);
});
test("rotation and reset invalidate retained signatures",async()=>{
 const f=await fixture();const row=await f.admission.compose("room","hello",()=>f.alice);assert.ok(row);
 f.keys.delete(f.alice.pub);assert.equal(f.admission.valid(row),false);
 f.keys.add(f.alice.pub);f.admission.reset();assert.equal(f.admission.valid(row),false);
});
