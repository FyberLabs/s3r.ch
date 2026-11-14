import test from "node:test";
import assert from "node:assert/strict";
import { p256 } from "@noble/curves/nist.js";
import { createForumAuthority, type ForumAuthoritySnapshot } from "./identity/forum-authority";
import { parseForumAuthority, type AuthorityKind } from "./identity/forum-authority-records";
import { seaToPrincipalKey } from "./identity/forum-check";
import type { ForumWitnessKey } from "./identity/forum-witness-verification";
import vectors from "./identity/vectors/forum-authority.json";
import { roomAuthorityDiagnosticsBlock } from "./room-authority-diagnostics";
const secret = (n: number) => { const bytes = new Uint8Array(32); bytes[31] = n; return bytes; };
const key = (n: number) => { const bytes = p256.getPublicKey(secret(n), false); return Buffer.from(bytes.slice(1,33)).toString("base64url") + "." + Buffer.from(bytes.slice(33)).toString("base64url"); };
const owner = key(1), time = 1700000060, forum = `forum_${seaToPrincipalKey(owner)}_${"1".repeat(32)}`;
function signed(kind: AuthorityKind, fields: Record<string, unknown>, n: number, issuedAt: number): ForumAuthoritySnapshot["rows"][number] {
 const record = {...fields, issuedAt, sig:"pending"}; const parsed = parseForumAuthority(kind,record); assert.ok(parsed);
 record.sig = Buffer.from(p256.sign(parsed.bytes,secret(n),{prehash:true,format:"compact"})).toString("base64url");
 return {kind,soul:parsed.soul,record};
}
const old = signed("object",{object:forum,owner},1,time-40), fresh = signed("object",{object:forum,owner},2,time-10);
const snapshot = (rows: ForumAuthoritySnapshot["rows"]): ForumAuthoritySnapshot => ({completeThrough:time,rows,history:{completeThrough:time,
 links:vectors.context.links.map(([,row])=>row),accounts:[{principal:owner,rotations:vectors.context.rotationSets.rotated,revocations:[],genesisEpubBindings:[]}]}});
const config = {keys:vectors.context.jwks.keys as ForumWitnessKey[],policy:vectors.context.policy,pinnedIssuers:vectors.context.pinnedIss};
test("retained old ownership permits room admission only beside current verified ownership", async () => {
 for (const rows of [[old,fresh],[fresh,old]]) {
  const authority = createForumAuthority(config,()=>time), input = snapshot(rows), result = await authority.refresh(input,time);
  assert.ok(result.ok); assert.equal(authority.graph.ownerOf(forum),owner);
  assert.deepEqual(result.diagnostics.map(row=>row.reason),["retired-key"]);
  assert.equal(roomAuthorityDiagnosticsBlock(result.diagnostics,input,authority.graph),false);
  assert.equal(authority.graph.principalForKey(key(2),time),owner);
 }
});
test("old-only, forged, grants and cancellations stay fatal for room admission", async () => {
 const grant = (stated: number) => signed("see",{object:forum,owner,accessor:owner,stated,from:0,until:time+60,hamState:1},1,time-40);
 for (const rows of [[old],[fresh,{...old,record:{...old.record as object,sig:"bad"}}],[fresh,grant(1)],[fresh,grant(0)]]) {
  const authority = createForumAuthority(config,()=>time), input = snapshot(rows), result = await authority.refresh(input,time);
  assert.ok(result.ok); assert.equal(roomAuthorityDiagnosticsBlock(result.diagnostics,input,authority.graph),true);
 }
 const authority=createForumAuthority(config,()=>time),input=snapshot([fresh]);
 const result=await authority.refresh({...input,history:{...input.history,accounts:[]}},time); assert.equal(result.ok,false);
});

test("old room sharing signs refreshed ownership with the current key and admission time", async () => {
 const {admitBrowserRoom} = await import("./room-authority-browser");
 const room = `room_${seaToPrincipalKey(owner)}_${"2".repeat(32)}`;
 const retained = signed("object",{object:room,owner},1,time-40);
 const otherRoom=room.replace("2".repeat(32),"6".repeat(32)), otherRetained=signed("object",{object:otherRoom,owner},1,time-40);
 let held = snapshot([old,fresh,retained,otherRetained]), posted: ForumAuthoritySnapshot["rows"] = [];
 const pair = {pub:key(2),priv:Buffer.from(secret(2)).toString("base64url"),epub:key(2),epriv:Buffer.from(secret(2)).toString("base64url")};
 const input = {item:{id:room,author:owner,ts:time-40},share:true,pair,config,
  squad:{forumId:forum,owner,label:"Rotation unit"},endpoint:"/room",clock:()=>time,signal:new AbortController().signal,
  read:async()=>held,fetch:(async (_url,init)=>{
   posted=JSON.parse(String(init?.body)).rows;
   assert.equal((posted[0].record as {issuedAt:number}).issuedAt,time);
   const candidate={...held,rows:[...held.rows,...posted]},authority=createForumAuthority(config,()=>time);
   const result=await authority.refresh(candidate,time); assert.ok(result.ok);
   assert.equal(roomAuthorityDiagnosticsBlock(result.diagnostics,candidate,authority.graph,(posted[0].record as {object:string}).object),false);
   held=candidate; return Response.json({ok:true});
  }) as typeof fetch};
 const result=await admitBrowserRoom(input);
 assert.equal(posted.length,1); assert.equal(result.snapshot.rows.length,5);
 assert.equal(result.snapshot.rows[2],retained); // history remains append-only
 const view=createForumAuthority(config,()=>time); await view.refresh(result.snapshot,time);
 assert.equal(view.graph.ownerOf(room),owner); assert.equal(view.graph.ownerOf(otherRoom),undefined);
 const second=await admitBrowserRoom({...input,item:{...input.item,id:otherRoom}});
 assert.equal(second.snapshot.rows.length,6); await view.refresh(second.snapshot,time);
 assert.equal(view.graph.ownerOf(room),owner); assert.equal(view.graph.ownerOf(otherRoom),owner);
 held=snapshot([old,retained]); posted=[];
 await assert.rejects(admitBrowserRoom(input),/denied/); assert.equal(posted.length,0);
 held=snapshot([fresh,{...retained,record:{...retained.record as object,sig:"forged"}}]);
 await assert.rejects(admitBrowserRoom(input),/denied/); assert.equal(posted.length,0);
});


test("protected reads return retired child ownership without granting child authority", async () => {
 const {createForumAuthorityService} = await import("./forum-authority-service");
 const room = `room_${seaToPrincipalKey(owner)}_${"3".repeat(32)}`;
 const retiredChild = signed("object",{object:room,owner},1,time-40);
 const liveOwner=key(53),liveForum=`forum_${seaToPrincipalKey(liveOwner)}_${"5".repeat(32)}`;
 const parent=signed("object",{object:liveForum,owner:liveOwner},53,time-10);
 const source=(rows: ForumAuthoritySnapshot["rows"])=>{const value=snapshot(rows);return {...value,history:{...value.history,
  accounts:[...value.history.accounts,{principal:liveOwner,rotations:[],revocations:[],genesisEpubBindings:[]}]}};};
 let held = source([parent,old,fresh,retiredChild]), reader=liveOwner;
 const service=createForumAuthorityService({squad:{forumId:liveForum,owner:liveOwner,label:"Read unit"},origin:"https://room.test",config,
  clock:()=>time,authenticate:async()=>({key:reader}),read:async()=>held});
 const request=()=>new Request("https://room.test/authority",{method:"POST",headers:{Origin:"https://room.test","Content-Type":"application/json"},
  body:JSON.stringify({version:1,forumId:liveForum,owner:liveOwner,evaluatedAt:time})});
 const response=await service(request()); assert.equal(response.status,200);
 const received=(await response.json()).snapshot,authority=createForumAuthority(config,()=>time);
 assert.ok((await authority.refresh(received,time)).ok);
 assert.equal(authority.graph.ownerOf(liveForum),liveOwner); assert.equal(authority.graph.ownerOf(room),undefined);
 assert.equal(authority.graph.checkForumSee(room,owner,time).allowed,false);
 reader=key(3); assert.equal((await service(request())).status,403);
 reader=liveOwner; held=source([old,retiredChild]); assert.equal((await service(request())).status,503);
 held=source([{...parent,record:{...parent.record as object,sig:"bad"}},retiredChild]); assert.equal((await service(request())).status,503);
 held=source([parent,fresh,{...retiredChild,record:{...retiredChild.record as object,sig:"bad"}}]);
 assert.equal((await service(request())).status,503);
 const grant=signed("see",{object:forum,owner,accessor:owner,stated:1,from:0,until:time+60,hamState:1},1,time-40);
 held=source([parent,fresh,grant]); assert.equal((await service(request())).status,503);
});

test("room append requires the authenticated stable owner and current replacement ownership", async () => {
 const {createBotStatementAdmission} = await import("./forum-bot-statement-admission");
 const room = `room_${seaToPrincipalKey(owner)}_${"4".repeat(32)}`;
 const oldRoom=signed("object",{object:room,owner},1,time-40),newRoom=signed("object",{object:room,owner},2,time);
 const other=room.replace("4".repeat(32),"7".repeat(32)),oldOther=signed("object",{object:other,owner},1,time-40);
 const rights=(["see","post"] as const).map(kind=>signed(kind,{object:forum,owner,accessor:key(3),stated:1,from:0,until:time+60,hamState:1},2,time-10));
 let held=snapshot([old,fresh,oldRoom,oldOther,...rights]),reader=key(3),appends=0;
 held={...held,history:{...held.history,accounts:[...held.history.accounts,{principal:key(3),rotations:[],revocations:[],genesisEpubBindings:[]}]}};
 const service=createBotStatementAdmission({squad:{forumId:forum,owner,label:"Append unit"},origin:"https://room.test",config,
  clock:()=>time,objectKind:"room",authenticate:async()=>({key:reader}),source:{read:async()=>({snapshot:held,fence:"held"}),
   append:async(_fence,rows,guard)=>{guard();appends++;held={...held,rows:[...held.rows,...rows]};return true;}}});
 const request=(rows: unknown[])=>new Request("https://room.test/room",{method:"POST",headers:{Origin:"https://room.test","Content-Type":"application/json"},
  body:JSON.stringify({version:1,forumId:forum,owner,evaluatedAt:time,rows})});
 assert.equal((await service(request([newRoom]))).status,403); assert.equal(appends,0);
 reader=key(2); assert.equal((await service(request([oldRoom]))).status,403); assert.equal(appends,0);
 assert.equal((await service(request([newRoom]))).status,200); assert.equal(appends,1);
 assert.equal(held.rows.includes(oldRoom),true); assert.equal(held.rows.length,7);
 const view=createForumAuthority(config,()=>time); await view.refresh(held,time);
 assert.equal(view.graph.ownerOf(other),undefined);
 assert.equal((await service(request([signed("object",{object:other,owner},2,time)]))).status,200);
 await view.refresh(held,time); assert.equal(view.graph.ownerOf(other),owner); assert.equal(appends,2);
});


test("room readiness rejects grant, cancellation and malformed diagnostics", async () => {
 const {createBotStatementAdmission}=await import("./forum-bot-statement-admission");
 let held=snapshot([old,fresh]);
 const service=createBotStatementAdmission({squad:{forumId:forum,owner,label:"Readiness unit"},origin:"https://room.test",config,
  clock:()=>time,objectKind:"room",authenticate:async()=>({key:key(2)}),source:{read:async()=>({snapshot:held,fence:"held"}),
   append:async()=>{throw Error("readiness cannot append");}}});
 const request=()=>new Request("https://room.test/room",{method:"POST",headers:{Origin:"https://room.test","Content-Type":"application/json"},
  body:JSON.stringify({version:1,forumId:forum,owner,evaluatedAt:time,rows:[]})});
 assert.equal((await service(request())).status,200);
 for (const stated of [0,1]) {
  held=snapshot([fresh,signed("see",{object:forum,owner,accessor:owner,stated,from:0,until:time+60,hamState:1},1,time-40)]);
  assert.equal((await service(request())).status,403);
 }
 held=snapshot([fresh,{...old,record:{bad:true}}]); assert.equal((await service(request())).status,403);
 held=snapshot([old]); assert.equal((await service(request())).status,403);
});
