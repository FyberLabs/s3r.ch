// HTTP and protected projection contracts run in CI only.
import test from "node:test";
import assert from "node:assert/strict";
import { parseMediaGroupView, parseMediaGroupAppend } from "./media-group";
import { createPrivateMediaOwner, PrivateMediaConflict } from "./media-owner-client";
import { createMediaOwnerService } from "./media-owner-service";
const owner="axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";
const reader="fPJ7GI0DT36KUjgDBLUaw8CJaeJ38hs1pgtI_EdmmXg.B3dVENuO0EApPZrGn3Qw27p9reY86YIpngS3nSJ4c9E";
const object="media_p_6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5_11111111111111111111111111111111";
const set=object.replace("media_","set_");
const edge={predicate:"same-group",setId:set,stated:1,hamState:3};
const member={...edge,accessor:reader,hamState:2};
const projection={object,set,predicate:"same-group",members:[reader],snapshot:{members:[member],objectSet:edge}};
const view={at:100,fence:"a".repeat(64),objectVersion:4,projection};
const rows=[{kind:"object",soul:object,record:{signature:"native-verifier-checks-this"}}];
const draft={predicate:"same-group",set,rows};
const signal=()=>new AbortController().signal;

test("group projection detaches state and preserves cancellation without owner shortcut",()=>{
  const parsed=parseMediaGroupView(view,object);assert.deepEqual(parsed,view);
  parsed.projection!.members.length=0;assert.equal(view.projection.members.length,1);
  assert.deepEqual(parseMediaGroupView({...view,projection:null},object).projection,null);
  const empty={object,set:null,predicate:null,members:[],snapshot:null};
  assert.deepEqual(parseMediaGroupView({...view,projection:empty},object).projection,empty);
  for(const part of ["member","edge"]){
    const p=structuredClone(projection);p.members=[];
    if(part==="member")p.snapshot.members[0].stated=0;else p.snapshot.objectSet.stated=0;
    assert.deepEqual(parseMediaGroupView({...view,projection:p},object).projection,p);
  }
  const p=structuredClone(projection);p.snapshot.members.unshift({...member,accessor:owner});
  assert.deepEqual(parseMediaGroupView({...view,projection:p},object).projection,p);
});
test("malformed, mismatched, duplicated and overclaimed projections fail closed",()=>{
  for(const input of [null,[],{...view,extra:1},{...view,at:-1},{...view,fence:"bad"},{...view,objectVersion:1.5},
    {...view,projection:{...projection,object:"other"}},{...view,projection:{...projection,members:[owner,reader]}},
    {...view,projection:{...projection,set:"set_bad"}},{...view,projection:{...projection,predicate:"see"}},
    {...view,projection:{...projection,snapshot:null}},{...view,projection:{...projection,members:[]}},
    {...view,projection:{...projection,snapshot:{members:[member,member],objectSet:edge}}},
    {...view,projection:{...projection,snapshot:{members:[{...member,hamState:-1}],objectSet:edge}}},
    {...view,projection:{...projection,snapshot:{members:[member],objectSet:{...edge,stated:0}}}},
    {...view,projection:{...projection,snapshot:{members:[],objectSet:{...edge,setId:"wrong"}}}}])
      assert.throws(()=>parseMediaGroupView(input,object));
  assert.throws(()=>parseMediaGroupView(view,"invalid"));
});
test("append inputs are bounded detached envelopes, not locally admitted signatures",()=>{
  assert.deepEqual(parseMediaGroupAppend(draft),draft);
  for(const input of [null,{...draft,extra:1},{...draft,predicate:"see"},{...draft,set:"invalid"},{...draft,rows:[]},
    {...draft,rows:Array(65).fill(rows[0])},{...draft,rows:[{...rows[0],record:{large:"x".repeat(65536)}}]},
    {...draft,rows:[{...rows[0],kind:"grant"}]},{...draft,rows:[{...rows[0],soul:""}]},{...draft,rows:[{...rows[0],record:[]}]}])
      assert.throws(()=>parseMediaGroupAppend(input));
});
test("client reads current projection and sends detached signed rows with a fresh fence",async()=>{
  const sent:unknown[]=[];const input=structuredClone(draft);
  const client=createPrivateMediaOwner(async(url,init)=>{
    assert.equal(init?.credentials,"same-origin");assert.equal(init?.redirect,"error");
    if(String(url).endsWith("group-view")){input.rows.length=0;return Response.json(view);}
    sent.push(JSON.parse(String(init?.body)));return Response.json({accepted:true});
  },()=>100);
  assert.deepEqual(await client.groupView(object),view);
  input.rows=structuredClone(rows);await client.appendGroupRows(object,input);
  assert.deepEqual(sent,[{object,at:100,fence:view.fence,...draft}]);
});
test("stale or invalid views and lost writes never replay group appends",async()=>{
  for(const failure of [409,500,200]){
    let calls=0;const client=createPrivateMediaOwner(async()=>++calls===1?Response.json(view):
      failure===200?Response.json({accepted:false}):new Response(null,{status:failure}),()=>100);
    await assert.rejects(client.appendGroupRows(object,draft),failure===409?PrivateMediaConflict:Error);assert.equal(calls,2);
  }
  let calls=0;const client=createPrivateMediaOwner(async()=>{if(++calls===1)return Response.json(view);throw Error("lost");},()=>100);
  await assert.rejects(client.appendGroupRows(object,draft));assert.equal(calls,2);
  let tick=0;const stale=createPrivateMediaOwner(async()=>Response.json(view),()=>tick++*5);
  await assert.rejects(stale.appendGroupRows(object,draft),PrivateMediaConflict);
  const invalid=createPrivateMediaOwner(async()=>Response.json({...view,projection:{...projection,members:[]}}),()=>100);
  await assert.rejects(invalid.appendGroupRows(object,draft));
  await assert.rejects(invalid.appendGroupRows("bad",draft));
  await assert.rejects(invalid.groupView(object,AbortSignal.abort()));
});
const config={origin:"https://gateway.example",tenant:"11111111-1111-4111-8111-111111111111",readers:[{principal:owner,apiKey:"fixed-owner-key"}]};
const request=(body:unknown)=>new Request("https://s3r.ch/api/media/owner/group-view",{method:"POST",headers:{origin:"https://s3r.ch","content-type":"application/json"},body:JSON.stringify(body)});
const write={object,at:100,fence:view.fence,...draft};
test("BFF binds group reads and writes to the authenticated fixed credential",async()=>{
  for(const [action,body,result] of [["group-view",{object},view],["group-append",write,{accepted:true}]] as const){
    const service=createMediaOwnerService(config,"https://s3r.ch",async()=>owner,async(url,init)=>{
      assert.equal(String(url),config.origin+"/api/v1/acl/sociacl/media/owner/"+action);
      assert.deepEqual(JSON.parse(String(init?.body)),body);assert.equal(new Headers(init?.headers).get("X-Api-Key"),"fixed-owner-key");
      return Response.json(result);
    },()=>100);
    const response=await service(action,request(body));assert.equal(response.status,200);
    assert.equal(response.headers.get("cache-control"),"private, no-store");assert.deepEqual(await response.json(),result);
  }
});
test("BFF refuses malformed group requests, projections, session changes and conflicts",async()=>{
  let calls=0;const service=createMediaOwnerService(config,"https://s3r.ch",async()=>owner,async()=>{calls++;return Response.json(view);},()=>100);
  for(const body of [{...write,fence:"bad"},{...write,rows:[]},{...write,owner},{...write,set:"invalid"}])
    assert.equal((await service("group-append",request(body))).status,400);
  assert.equal(calls,0);
  const bad=createMediaOwnerService(config,"https://s3r.ch",async()=>owner,async()=>Response.json({...view,projection:{...projection,members:[]}}),()=>100);
  assert.equal((await bad("group-view",request({object}))).status,403);
  let resolves=0;const changed=createMediaOwnerService(config,"https://s3r.ch",async()=>++resolves===1?owner:reader,async()=>Response.json(view),()=>100);
  assert.equal((await changed("group-view",request({object}))).status,403);
  const conflict=createMediaOwnerService(config,"https://s3r.ch",async()=>owner,async()=>new Response(null,{status:409}),()=>100);
  assert.equal((await conflict("group-append",request(write))).status,409);
});
