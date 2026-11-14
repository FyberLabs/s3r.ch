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
 let held = snapshot([old,fresh,retained]), posted: ForumAuthoritySnapshot["rows"] = [];
 const pair = {pub:key(2),priv:Buffer.from(secret(2)).toString("base64url"),epub:key(2),epriv:Buffer.from(secret(2)).toString("base64url")};
 const input = {item:{id:room,author:owner,ts:time-40},share:true,pair,config,
  squad:{forumId:forum,owner,label:"Rotation unit"},endpoint:"/room",clock:()=>time,signal:new AbortController().signal,
  read:async()=>held,fetch:(async (_url,init)=>{
   posted=JSON.parse(String(init?.body)).rows;
   assert.equal((posted[0].record as {issuedAt:number}).issuedAt,time);
   const candidate={...held,rows:[...held.rows,...posted]},authority=createForumAuthority(config,()=>time);
   const result=await authority.refresh(candidate,time); assert.ok(result.ok);
   assert.equal(roomAuthorityDiagnosticsBlock(result.diagnostics,candidate,authority.graph),false);
   held=candidate; return Response.json({ok:true});
  }) as typeof fetch};
 const result=await admitBrowserRoom(input);
 assert.equal(posted.length,1); assert.equal(result.snapshot.rows.length,4);
 assert.equal(result.snapshot.rows[2],retained); // history remains append-only
 held=snapshot([old,retained]); posted=[];
 await assert.rejects(admitBrowserRoom(input),/denied/); assert.equal(posted.length,0);
 held=snapshot([fresh,{...retained,record:{...retained.record as object,sig:"forged"}}]);
 await assert.rejects(admitBrowserRoom(input),/denied/); assert.equal(posted.length,0);
});
