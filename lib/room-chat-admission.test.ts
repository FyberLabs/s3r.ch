import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { mergeChat } from "./chat";
import { createRoomChatAdmission, type SignedRoomChat } from "./room-chat-admission";
import { signForumRecord } from "./forum-sign";
import { admittedRoomGames, roomGames } from "./room-game";
import { admittedRoomTasks } from "./room-tasks";
import { encodeKey } from "./identity/check";
import type { ForumAuthorityGraph } from "./identity/forum-authority";
import type { SeaPair } from "./identity/sea";
const TASK_PREFIX="s3rch-work:v1:";
const sea=createRequire(import.meta.url)("gun/sea") as {pair():Promise<SeaPair>};
// Unit contract substitutes the already-verified authority graph, not signature verification.
async function fixture(){
 const alice=await sea.pair(),bob=await sea.pair();let access=true, reader: string | null=alice.pub;
 const keys=new Set([alice.pub,bob.pub]);
 const graph={writerKey:(p:string)=>keys.has(p)?p:null,principalForKey:(p:string)=>keys.has(p)?p:null,
  checkForumSee:()=>({allowed:access}),checkPost:()=>({allowed:access})} as unknown as ForumAuthorityGraph;
 const admission=createRoomChatAdmission({graph,readerKey:()=>reader,clock:()=>100});
 return {alice,bob,admission,keys,revoke:()=>{access=false;}, restore:()=>{access=true;},reader:(key:string|null)=>{reader=key;}};
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

test("an authorized signer cannot preempt another author's message or task ID", async () => {
 const f = await fixture();
 const created = await f.admission.compose("room", TASK_PREFIX + JSON.stringify(["create", "task", "Review", "room", "open", null]), () => f.alice);
 assert.ok(created);
 const { sig: ignored, ...fields } = created;
 const forged = { ...fields, author: f.bob.pub };
 const sig = await signForumRecord({ domain: "s3rch-room-chat/v1", ...forged }, f.bob);
 assert.ok(sig);
 assert.equal(await f.admission.receive({ ...forged, sig }, "room", encodeKey(created.id)), null);
});

test("locking or replacing the key during asynchronous receive cancels a pending send", async () => {
 for (const replacement of ["locked", "replaced"] as const) {
  const f = await fixture(); let calls = 0, changed = false;
  const composed = await f.admission.compose("room", "pending", () => {
   if (++calls === 2) queueMicrotask(() => { changed = true; });
   return changed ? (replacement === "locked" ? null : f.bob) : f.alice;
  });
  assert.equal(composed, null, replacement);
 }
});


test("signed games use admitted compact predecessors and lose visibility on revocation", async () => {
 const f = await fixture();
 const send = (action: unknown[], pair: SeaPair) => f.admission.compose("room", "s3rch-game:v1:" + JSON.stringify(action), () => pair);
 assert.equal(f.admission.canCompose("room", () => f.alice), true);
 assert.equal(f.admission.canCompose("room", () => null), false);
 const start = await send(["start"], f.alice); assert.ok(start);
 const join = await send(["join", start.id, start.id], f.bob); assert.ok(join);
 const move = await send(["move", start.id, join.id, 4], f.alice); assert.ok(move);
 const wrongTurn = await send(["move", start.id, move.id, 0], f.alice); assert.ok(wrongTurn);
 const rows = [wrongTurn, move, join, start];
 const game = admittedRoomGames(rows, "room", f.admission)[0];
 assert.equal(game.x, f.alice.pub); assert.equal(game.o, f.bob.pub);
 assert.equal(game.board[4], "X"); assert.equal(game.board[0], null); assert.equal(game.head, move.id);
 assert.deepEqual(roomGames(rows, "room"), []);
 assert.deepEqual(admittedRoomGames(rows.map(row => ({...row})), "room", f.admission), []);
 f.revoke(); assert.equal(f.admission.canCompose("room", () => f.alice), false);
 assert.deepEqual(admittedRoomGames(rows, "room", f.admission), []);
});


test("readmitting cached history replaces invalidated objects with fresh proofs", async () => {
 const f = await fixture();
 const original = await f.admission.compose("room", "retained history", () => f.alice); assert.ok(original);
 f.admission.reset(); assert.equal(f.admission.valid(original), false);
 const refreshed = await f.admission.receive(original, "room", encodeKey(original.id)); assert.ok(refreshed);
 assert.notEqual(refreshed, original);
 const cache = mergeChat([refreshed], [original]);
 assert.equal(cache.length, 1); assert.equal(cache[0], refreshed);
 assert.deepEqual(f.admission.readable(cache, "room"), [refreshed]);
});

test("queued history admits a forty-message burst using immutable envelopes", async () => {
 const {createRoomChatReceiveQueue} = await import("./room-chat-receive-queue");
 const f=await fixture(), rows=[];
 for(let i=0;i<40;i++) { const row=await f.admission.compose("room",`message ${i}`,()=>f.alice); assert.ok(row); rows.push(row); }
 f.admission.reset();
 const accepted: string[]=[];
 const queue=createRoomChatReceiveQueue(f.admission,"room",row=>accepted.push(row.body));
 const tasks=rows.map(row=>{const transport={...row};const done=queue.enqueue(transport,encodeKey(row.id));transport.body="mutated";return done;});
 await Promise.all(tasks);
 assert.deepEqual(accepted,rows.map(row=>row.body));
 queue.close();
 await queue.enqueue(rows[0],encodeKey(rows[0].id));assert.equal(accepted.length,40);
});

test("closing a receive queue fences in-flight and pending messages", async () => {
 const {createRoomChatReceiveQueue} = await import("./room-chat-receive-queue");
 const f=await fixture();const row=await f.admission.compose("room","pending",()=>f.alice);assert.ok(row);
 let release!:()=>void, entered!:()=>void, accepted=0, calls=0;
 const gate=new Promise<void>(resolve=>{release=resolve;});const started=new Promise<void>(resolve=>{entered=resolve;});
 const admission={...f.admission,receive:async(...args:Parameters<typeof f.admission.receive>)=>{calls++;entered();await gate;return f.admission.receive(...args);}};
 const queue=createRoomChatReceiveQueue(admission,"room",()=>accepted++);
 const done=queue.enqueue(row,encodeKey(row.id));await started;
 void queue.enqueue(row,encodeKey(row.id));queue.close();release();await done;
 assert.equal(calls,1);assert.equal(accepted,0);
});

test("authority refresh pauses and resumes queued history without replaying its prefix", async () => {
 const {createRoomChatReceiveQueue} = await import("./room-chat-receive-queue");
 const f=await fixture(), rows=[];
 for(let i=0;i<40;i++){const row=await f.admission.compose("room",`refresh ${i}`,()=>f.alice);assert.ok(row);rows.push(row);}
 let ready=true, calls=0, release!:()=>void, entered!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});const started=new Promise<void>(resolve=>{entered=resolve;});
 const admission={...f.admission,receive:async(...args:Parameters<typeof f.admission.receive>)=>{
  if(++calls===11){entered();await gate;}return f.admission.receive(...args);
 }};
 const accepted:string[]=[];
 const queue=createRoomChatReceiveQueue(admission,"room",row=>accepted.push(row.body),()=>ready);
 const pending=rows.map(row=>queue.enqueue(row,encodeKey(row.id)));
 await started;ready=false;release();await Promise.all(pending);
 assert.equal(accepted.length,10);assert.equal(calls,11);
 await queue.resume();assert.equal(calls,11);
 ready=true;await queue.resume();
 assert.equal(calls,41);assert.equal(accepted.length,40);assert.equal(new Set(accepted).size,40);
 queue.close();
});

test("history arriving before grants is revalidated after authority changes", async () => {
 const {createRoomChatReceiveQueue} = await import("./room-chat-receive-queue");
 const f=await fixture();const row=await f.admission.compose("room","waiting for grant",()=>f.alice);assert.ok(row);
 f.revoke();const accepted:string[]=[];
 const queue=createRoomChatReceiveQueue(f.admission,"room",message=>accepted.push(message.body));
 await queue.enqueue(row,encodeKey(row.id));assert.deepEqual(accepted,[]);
 await queue.resume();assert.deepEqual(accepted,[]);
 f.restore();await queue.resume();assert.deepEqual(accepted,[row.body]);
 await queue.resume();assert.deepEqual(accepted,[row.body]);
 queue.close();
});


test("rejected history cannot exhaust capacity for later authenticated messages", async () => {
 const {createRoomChatReceiveQueue}=await import("./room-chat-receive-queue");
 const f=await fixture(), row=await f.admission.compose("room","valid after flood",()=>f.alice);assert.ok(row);
 const accepted:string[]=[];
 const queue=createRoomChatReceiveQueue(f.admission,"room",message=>accepted.push(message.body));
 await Promise.all(Array.from({length:8192},(_,i)=>{
  const forged={...row,id:"s3rch:chat:"+i.toString(16).padStart(64,"0"),sig:"invalid"};
  return queue.enqueue(forged,encodeKey(forged.id));
 }));
 assert.deepEqual(accepted,[]);
 await queue.enqueue(row,encodeKey(row.id));assert.deepEqual(accepted,[row.body]);
 await queue.resume();assert.deepEqual(accepted,[row.body]);
 queue.close();
});


test("a valid arrival after an undrained poison burst still reaches admission", async () => {
 const {createRoomChatReceiveQueue}=await import("./room-chat-receive-queue");
 const f=await fixture(), row=await f.admission.compose("room","fresh during flood",()=>f.alice);assert.ok(row);
 const accepted:string[]=[];
 const queue=createRoomChatReceiveQueue(f.admission,"room",message=>accepted.push(message.body));
 const pending=Array.from({length:8192},(_,i)=>{
  const forged={...row,id:"s3rch:chat:"+i.toString(16).padStart(64,"0"),sig:"invalid"};
  return queue.enqueue(forged,encodeKey(forged.id));
 });
 // Do not yield to the microtask drain before the 8193rd, authentic arrival.
 pending.push(queue.enqueue(row,encodeKey(row.id)));
 await Promise.all(pending);assert.deepEqual(accepted,[row.body]);
 await queue.resume();assert.deepEqual(accepted,[row.body]);queue.close();
});


test("authenticated progress survives reverse-order poison overflow", async () => {
 const {createRoomChatReceiveQueue}=await import("./room-chat-receive-queue");
 const f=await fixture(), row=await f.admission.compose("room","valid before flood",()=>f.alice);assert.ok(row);
 const accepted:string[]=[];
 const queue=createRoomChatReceiveQueue(f.admission,"room",message=>accepted.push(message.body));
 const pending=[queue.enqueue(row,encodeKey(row.id))];
 for(let i=0;i<8448;i++) {
  const forged={...row,id:"s3rch:chat:"+i.toString(16).padStart(64,"0")};
  pending.push(queue.enqueue(forged,encodeKey(forged.id)));
 }
 await Promise.all(pending);assert.deepEqual(accepted,[row.body]);
 await queue.resume();assert.deepEqual(accepted,[row.body]);queue.close();
});

test("queue priority checks signatures and never grants display authority", async () => {
 const f=await fixture(), row=await f.admission.compose("room","priority",()=>f.alice);assert.ok(row);
 assert.equal(await f.admission.authenticateEnvelope(row),true);
 const wrapped=JSON.parse(row.sig.slice(3));wrapped.s="A".repeat(86)+"==";
 assert.equal(await f.admission.authenticateEnvelope({...row,sig:"SEA"+JSON.stringify(wrapped)}),false);
 f.revoke();assert.equal(await f.admission.authenticateEnvelope(row),true);
 assert.equal(await f.admission.receive(row,"room",encodeKey(row.id)),null);
 f.keys.delete(f.alice.pub);assert.equal(await f.admission.authenticateEnvelope(row),true);
 assert.equal(await f.admission.receive(row,"room",encodeKey(row.id)),null);
 f.admission.reset();assert.equal(await f.admission.authenticateEnvelope(row),null);
});


test("unknown-author flooding cannot displace authenticated late-grant retries", async () => {
 const {createRoomChatReceiveQueue}=await import("./room-chat-receive-queue");
 const f=await fixture(), row=await f.admission.compose("room","waiting safely",()=>f.alice);assert.ok(row);
 f.revoke();const accepted:string[]=[];
 const queue=createRoomChatReceiveQueue(f.admission,"room",message=>accepted.push(message.body));
 await queue.enqueue(row,encodeKey(row.id));f.keys.delete(f.bob.pub);
 for(let i=0;i<8448;i++) {
  const forged={...row,author:f.bob.pub,id:"s3rch:chat:"+i.toString(16).padStart(64,"0")};
  void queue.enqueue(forged,encodeKey(forged.id));
 }
 f.restore();await queue.resume();assert.deepEqual(accepted,[row.body]);queue.close();
});


test("initial history waits for authority and later refreshes retain the subscription", async () => {
 const {createRoomChatSubscription}=await import("./room-chat-receive-queue");
 const f=await fixture(), rows: SignedRoomChat[]=[];
 for(let i=0;i<300;i++){const row=await f.admission.compose("room",`initial ${i}`,()=>f.alice);assert.ok(row);rows.push(row);}
 let ready=false, subscriptions=0, stopped=0, changed=()=>{};
 const accepted:string[]=[];
 // Transport substitute replays cached history synchronously on subscription.
 const subscription=createRoomChatSubscription({admission:f.admission,room:"room",receive:row=>accepted.push(row.id),ready:()=>ready,
  observeAuthority:fn=>{changed=fn;return()=>{changed=()=>{};};},
  subscribe:receive=>{subscriptions++;for(const row of rows)receive(row,encodeKey(row.id));return()=>{stopped++;};}});
 assert.equal(subscriptions,0);assert.deepEqual(accepted,[]);
 ready=true;changed();await subscription.refresh();
 assert.equal(subscriptions,1);assert.equal(accepted.length,300);assert.equal(new Set(accepted).size,300);
 ready=false;changed();ready=true;changed();await subscription.refresh();
 assert.equal(subscriptions,1);assert.equal(accepted.length,300);
 subscription.close();assert.equal(stopped,1);changed();await subscription.refresh();assert.equal(subscriptions,1);
});


test("ingress bounds asynchronous verification and yields during peer floods", async () => {
 const {createRoomChatReceiveQueue}=await import("./room-chat-receive-queue");
 const f=await fixture(), row=await f.admission.compose("room","bounded",()=>f.alice);assert.ok(row);
 let release!:()=>void, calls=0, active=0, maximum=0;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 // Substitute only the verifier latency/result to measure scheduling bounds.
 const admission={...f.admission,authenticateEnvelope:async()=>{
  calls++;active++;maximum=Math.max(maximum,active);await gate;active--;return false;
 }};
 const queue=createRoomChatReceiveQueue(admission,"room",()=>assert.fail("invalid rows must not display"));
 const jobs=Array.from({length:8448},(_,i)=>{
  const input={...row,id:"s3rch:chat:"+i.toString(16).padStart(64,"0")};return queue.enqueue(input,encodeKey(input.id));
 });
 assert.equal(calls,1);assert.equal(maximum,1);
 let timerCalls=0;const timer=setTimeout(()=>{timerCalls=calls;},0);
 release();await Promise.all(jobs);clearTimeout(timer);
 assert.equal(maximum,1);assert.equal(calls,8193);assert.ok(timerCalls>0 && timerCalls<calls);
 queue.close();
});


test("same-identity refresh fences and restores Mine-only receipts without replay", async () => {
 const {mineOwnerChanged}=await import("./mine-session");
 const f=await fixture(), row=await f.admission.compose("room","local only",()=>f.alice);assert.ok(row);
 let held:string|null=f.alice.pub;
 const observe=(key:string|null|undefined)=>{
  f.reader(key??null);
  if(mineOwnerChanged(held,key)){held=key!;f.admission.reset();}
 };
 assert.deepEqual(f.admission.readable([row],"room"),[row]);
 observe(undefined);assert.deepEqual(f.admission.readable([row],"room"),[]);
 assert.equal(await f.admission.compose("room","pending refresh",()=>f.alice),null);
 observe(f.alice.pub);assert.deepEqual(f.admission.readable([row],"room"),[row]);
 observe(f.bob.pub);assert.deepEqual(f.admission.readable([row],"room"),[]);
 observe(f.alice.pub);assert.deepEqual(f.admission.readable([row],"room"),[]);
});


test("room sharing publishes current local rows and late composition uses current visibility", async () => {
 const {publishCurrentRoomChat}=await import("./room-chat-publication");
 const f=await fixture(), rows:SignedRoomChat[]=[], sent:string[]=[];
 let publicRoom=false, release!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const publish=(currentRows:()=>readonly SignedRoomChat[])=>publishCurrentRoomChat({room:"room",currentRows,
  publicRoom:()=>publicRoom,admission:f.admission,publish:row=>sent.push(row.id)});
 const sharing=(async()=>{await gate;publicRoom=true;publish(()=>rows);})();
 const before=await f.admission.compose("room","during admission",()=>f.alice);assert.ok(before);rows.push(before);
 const task=await f.admission.compose("room",TASK_PREFIX+JSON.stringify(["create","task","private work","mine","open",null]),()=>f.alice);
 const other=await f.admission.compose("other-room","different room",()=>f.alice);
 assert.ok(task);assert.ok(other);rows.push(task,other);
 release();await sharing;assert.deepEqual(sent,[before.id]);
 const after=await f.admission.compose("room","late completion",()=>f.alice);assert.ok(after);rows.push(after);
 publish(()=>[after]);assert.deepEqual(sent,[before.id,after.id]);
 publicRoom=false;publish(()=>rows);assert.equal(sent.length,2);
 publicRoom=true;f.revoke();publish(()=>rows);assert.equal(sent.length,2);
});


test("unsigned mesh visibility cannot authorize publication of the owner's Mine chat", async () => {
 const {roomChatPublicationAllowed}=await import("./room-chat-publication");
 const f=await fixture(), row=await f.admission.compose("room","Mine only",()=>f.alice);assert.ok(row);
 const publishedRooms=new Set(["room"]),ownerConfirmedShares=new Set<string>();
 // Substitute an already authenticated authority graph; the hostile mesh can
 // change only publishedRooms, never this owner binding or the local receipt.
 const graph={ownerOf:()=>f.alice.pub,principalForKey:(key:string)=>f.keys.has(key)?key:null};
 const allowed=()=>roomChatPublicationAllowed({room:"room",readerKey:f.alice.pub,now:100,graph,publishedRooms,ownerConfirmedShares});
 assert.equal(allowed(),false);assert.equal(f.admission.valid(row),true);
 const {publishCurrentRoomChat}=await import("./room-chat-publication");let puts=0;
 const publish=()=>publishCurrentRoomChat({room:"room",currentRows:()=>[row],publicRoom:allowed,admission:f.admission,publish:()=>{puts++;}});
 publish();assert.equal(puts,0);
 ownerConfirmedShares.add("room");publish();assert.equal(puts,1);
 ownerConfirmedShares.delete("room");publishedRooms.add("room");publish();assert.equal(puts,1);
 const restarted=new Set<string>();assert.equal(roomChatPublicationAllowed({room:"room",readerKey:f.alice.pub,now:100,graph,publishedRooms,ownerConfirmedShares:restarted}),false);
});

test("media references retain signed author, room and current permission checks",async()=>{
 const {composeRoomMedia,parseRoomMedia}=await import("./room-media");
 const f=await fixture(),object='media_p_7cf27b188d034f7e8a52380304b51ac3c08969e277f21b35a60b48fc4766997807775510db8ed040293d9ac69f7430dbba7dade63ce982299e04b79d227873d1_22222222222222222222222222222222';
 const body=composeRoomMedia(object);assert.ok(body);
 const row=await f.admission.compose("room",body,()=>f.alice);assert.ok(row);
 assert.equal(parseRoomMedia(row.body),object);
 assert.equal(await f.admission.receive({...row,body:composeRoomMedia(object.replace(/2$/, "3"))},"room",encodeKey(row.id)),null);
 assert.equal(await f.admission.receive(row,"other-room",encodeKey(row.id)),null);
 f.revoke();assert.deepEqual(f.admission.readable([row],"room"),[]);
});

 test("closing the room-media composer during signing refuses publication",async()=>{
 const {composeCurrentRoomMedia}=await import("./room-media-composition");
 const {composeRoomMedia}=await import("./room-media");
 const f=await fixture();
 const object='media_p_7cf27b188d034f7e8a52380304b51ac3c08969e277f21b35a60b48fc4766997807775510db8ed040293d9ac69f7430dbba7dade63ce982299e04b79d227873d1_22222222222222222222222222222222';
 const body=composeRoomMedia(object);assert.ok(body);
 let current=true;
 const pending=composeCurrentRoomMedia({room:"room",body,admission:f.admission,pair:()=>f.alice,current:()=>current});
 current=false;assert.equal(await pending,null);
 current=true;assert.ok(await composeCurrentRoomMedia({room:"room",body,admission:f.admission,pair:()=>f.alice,current:()=>current}));
 });


test("signed task creation, status, SEA assignment and explicit shared copies preserve Mine privacy", async () => {
 const {publishCurrentRoomChat}=await import("./room-chat-publication");
 const f=await fixture(), rows:SignedRoomChat[]=[], sent:string[]=[];
 const compose=async(action:unknown[],pair=f.alice)=>{const row=await f.admission.compose("room",TASK_PREFIX+JSON.stringify(action),()=>pair);assert.ok(row);rows.push(row);return row;};
 const create=await compose(["create","task","Private work","mine","open",null]);
 const status=await compose(["status",create.id,create.id,"doing"]);
 const assign=await compose(["assign",create.id,status.id,f.bob.pub]);
 assert.equal(admittedRoomTasks(rows,"room",f.admission)[0].assignee,f.bob.pub);
 const forged=await compose(["status",create.id,assign.id,"done"],f.bob);
 assert.equal(admittedRoomTasks(rows,"room",f.admission)[0].status,"doing");
 const publish=(subset:SignedRoomChat[])=>publishCurrentRoomChat({room:"room",currentRows:()=>subset,taskHistory:()=>rows,
   publicRoom:()=>true,admission:f.admission,publish:row=>sent.push(row.id)});
 publish(rows);assert.equal(sent.length,0);
 const shared=await compose(["create","task","Private work","room","doing",f.bob.pub]);
 const changed=await compose(["status",shared.id,shared.id,"done"]);
 publish([changed]);assert.deepEqual(sent,[changed.id]);
 sent.length=0;publish(rows);assert.deepEqual(sent,[shared.id,changed.id]);
 assert.equal(sent.includes(forged.id),false);
 f.revoke();publish(rows);assert.deepEqual(sent,[shared.id,changed.id]);
});
test("bounded task payload supports escaped titles and full SEA assignment, ordinary chat remains bounded",async()=>{
 const f=await fixture();
 const body=TASK_PREFIX+JSON.stringify(["create","task",'"'.repeat(80),"room","open",f.bob.pub]);
 assert.ok(body.length>280);assert.ok(await f.admission.compose("room",body,()=>f.alice));
 assert.equal(await f.admission.compose("room","x".repeat(281),()=>f.alice),null);
 assert.equal(await f.admission.compose("room",TASK_PREFIX+"x".repeat(512),()=>f.alice),null);
});

test("unrelated admitted room histories cannot suppress shared task publication",async()=>{
 const {publishCurrentRoomChat}=await import("./room-chat-publication");
 const f=await fixture();
 const task=await f.admission.compose("room",TASK_PREFIX+JSON.stringify(["create","task","Shared","room","open",null]),()=>f.alice);
 const other=await f.admission.compose("another-room","other history",()=>f.alice);assert.ok(task);assert.ok(other);
 const sent:string[]=[];
 publishCurrentRoomChat({room:"room",currentRows:()=>[task],taskHistory:()=>[...Array(8193).fill(other),task],
  publicRoom:()=>true,admission:f.admission,publish:row=>sent.push(row.id)});
 assert.deepEqual(sent,[task.id]);
});
