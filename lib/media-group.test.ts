// HTTP and protected projection contracts run in CI only.
import test from "node:test";
import assert from "node:assert/strict";
import { parseMediaGroupWriteState, parseMediaGroupAuthority, parseMediaGroupPolicyView, parseMediaGroupPolicy, parseMediaGroupScope, parseMediaGroupView, parseMediaGroupAppend } from "./media-group";
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
const appendState={at:100,fence:view.fence,state:"absent"};
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
    if(String(url).endsWith("group-check")){input.rows.length=0;return Response.json(appendState);}
    sent.push(JSON.parse(String(init?.body)));return Response.json({accepted:true});
  },()=>100);
  assert.deepEqual(await client.groupView(object),view);
  input.rows=structuredClone(rows);await client.appendGroupRows(object,input);
  assert.deepEqual(sent,[{object,at:100,fence:view.fence,...draft}]);
});
test("stale or invalid views and lost writes never replay group appends",async()=>{
  for(const failure of [409,500,200]){
    let calls=0;const client=createPrivateMediaOwner(async()=>++calls===1?Response.json(appendState):
      failure===200?Response.json({accepted:false}):new Response(null,{status:failure}),()=>100);
    await assert.rejects(client.appendGroupRows(object,draft),failure===409?PrivateMediaConflict:Error);assert.equal(calls,2);
  }
  let calls=0;const client=createPrivateMediaOwner(async()=>{if(++calls===1)return Response.json(appendState);throw Error("lost");},()=>100);
  await assert.rejects(client.appendGroupRows(object,draft));assert.equal(calls,2);
  let tick=0;const stale=createPrivateMediaOwner(async()=>Response.json(appendState),()=>tick++*5);
  await assert.rejects(stale.appendGroupRows(object,draft),PrivateMediaConflict);
  const invalid=createPrivateMediaOwner(async()=>Response.json({...appendState,state:"unknown"}),()=>100);
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

const policyScope={predicate:"same-group" as const,set};
const policy={owner,setId:set,predicate:"same-group" as const,settleWindowMs:3600000,configRevision:1,signature:"b".repeat(128)};
const policyView={at:100,fence:view.fence,context:{owner,ownerPub:owner,setId:set,predicate:"same-group"},config:policy};
test("group policy parsers bind canonical scope and independently resolved set owner",()=>{
  assert.deepEqual(parseMediaGroupPolicyView(policyView,policyScope),policyView);
  assert.equal(parseMediaGroupPolicyView({...policyView,config:null},policyScope).config,null);
  for(const bad of [null,{}, {...policyScope,predicate:"direct"},{...policyScope,set:"set_bad"}])assert.throws(()=>parseMediaGroupScope(bad));
  for(const bad of [null,{...policy,extra:1},{...policy,owner:reader},{...policy,setId:object},{...policy,predicate:"named-circle"},
    {...policy,settleWindowMs:3599999},{...policy,settleWindowMs:259200001},{...policy,settleWindowMs:NaN},
    {...policy,configRevision:-1},{...policy,signature:"bad"}])assert.throws(()=>parseMediaGroupPolicy(bad,policyScope));
  for(const bad of [null,{...policyView,at:-1},{...policyView,fence:"bad"},{...policyView,extra:1},
    {...policyView,context:{...policyView.context,owner:reader}},{...policyView,context:{...policyView.context,ownerPub:"bad"}},
    {...policyView,context:{...policyView.context,setId:object}},{...policyView,context:{...policyView.context,predicate:"named-circle"}}])
    assert.throws(()=>parseMediaGroupPolicyView(bad,policyScope));
});
test("group policy signer uses packed shared producer and holds only a key copy",async()=>{
  const key=new Uint8Array(32);key[31]=1;
  const client=createPrivateMediaOwner(async()=>{key.fill(0);return Response.json(policyView);},()=>100);
  const signed=await client.prepareGroupPolicy(object,policyScope,7200000,owner,key);
  assert.equal(signed.configRevision,2);assert.equal(signed.settleWindowMs,7200000);
  assert.equal(signed.owner,owner);assert.match(signed.signature,/^[a-f0-9]{128}$/);
  const scalar=()=>{const key=new Uint8Array(32);key[31]=1;return key;};
  const bad=createPrivateMediaOwner(async()=>Response.json({...policyView,context:{...policyView.context,ownerPub:reader}}),()=>100);
  await assert.rejects(bad.prepareGroupPolicy(object,policyScope,3600000,owner,scalar()));
  await assert.rejects(client.prepareGroupPolicy(object,policyScope,3600000,reader,scalar()));
  await assert.rejects(client.prepareGroupPolicy("bad",policyScope,3600000,owner,scalar()));
  const exhausted=createPrivateMediaOwner(async()=>Response.json({...policyView,config:{...policy,configRevision:Number.MAX_SAFE_INTEGER}}),()=>100);
  await assert.rejects(exhausted.prepareGroupPolicy(object,policyScope,3600000,owner,scalar()));
  const empty=createPrivateMediaOwner(async()=>Response.json({...policyView,config:null}),()=>100);
  assert.equal((await empty.prepareGroupPolicy(object,policyScope,3600000,owner,scalar())).configRevision,1);
});
test("group policy append detaches signed material and never retries lost or stale writes",async()=>{
  const signed={...policy};let sent:unknown;
  const client=createPrivateMediaOwner(async(url,init)=>{
    if(String(url).endsWith("group-policy-view")){signed.signature="c".repeat(128);return Response.json(policyView);}
    sent=JSON.parse(String(init?.body));return Response.json({accepted:true});
  },()=>100);
  assert.deepEqual(await client.groupPolicyView(object,policyScope),policyView);
  signed.signature=policy.signature;await client.appendGroupPolicy(object,policyScope,signed);
  assert.deepEqual(sent,{object,at:100,fence:view.fence,...policyScope,config:policy});
  for(const code of [409,500,200]){
    let calls=0;const failed=createPrivateMediaOwner(async()=>++calls===1?Response.json(policyView):code===200?Response.json({accepted:false}):new Response(null,{status:code}),()=>100);
    await assert.rejects(failed.appendGroupPolicy(object,policyScope,policy),code===409?PrivateMediaConflict:Error);assert.equal(calls,2);
  }
  let calls=0;const lost=createPrivateMediaOwner(async()=>{if(++calls===1)return Response.json(policyView);throw Error("lost");},()=>100);
  await assert.rejects(lost.appendGroupPolicy(object,policyScope,policy));assert.equal(calls,2);
  let tick=0;const stale=createPrivateMediaOwner(async()=>Response.json(policyView),()=>tick++*5);
  await assert.rejects(stale.appendGroupPolicy(object,policyScope,policy),PrivateMediaConflict);
  await assert.rejects(client.appendGroupPolicy("bad",policyScope,policy));
  await assert.rejects(client.groupPolicyView("bad",policyScope));
});
test("group policy BFF validates fixed-session requests and returned signing context",async()=>{
  const write={object,at:100,fence:view.fence,...policyScope,config:policy};
  for(const [action,body,result] of [["group-policy-view",{object,...policyScope},policyView],["group-policy-append",write,{accepted:true}]] as const){
    const service=createMediaOwnerService(config,"https://s3r.ch",async()=>owner,async(url,init)=>{
      assert.equal(String(url),config.origin+"/api/v1/acl/sociacl/media/owner/"+action);
      assert.equal(new Headers(init?.headers).get("X-Api-Key"),"fixed-owner-key");
      assert.deepEqual(JSON.parse(String(init?.body)),body);return Response.json(result);
    },()=>100);
    assert.equal((await service(action,request(body))).status,200);
  }
  let calls=0;const service=createMediaOwnerService(config,"https://s3r.ch",async()=>owner,async()=>{calls++;return Response.json(policyView);},()=>100);
  for(const patch of [{ownerPub:reader},{config:{...policy,owner:reader}},{set:"invalid"},{fence:"bad"}])
    assert.equal((await service("group-policy-append",request({...write,...patch}))).status,400);
  assert.equal(calls,0);
  const bad=createMediaOwnerService(config,"https://s3r.ch",async()=>owner,async()=>Response.json({...policyView,context:{...policyView.context,owner:reader}}),()=>100);
  assert.equal((await bad("group-policy-view",request({object,...policyScope}))).status,403);
  let principal=0;const changed=createMediaOwnerService(config,"https://s3r.ch",async()=>++principal===1?owner:reader,async()=>Response.json(policyView),()=>100);
  assert.equal((await changed("group-policy-view",request({object,...policyScope}))).status,403);
});

const directEntry={accessor:reader,grantRevision:2,stated:0,from:0,until:200000,scope:"direct",setId:"",hamState:0};
const authority={...view,owner,direct:{entries:[directEntry]},policy:{context:policyView.context,config:policy},
  bindings:{[owner]:{pub:owner,epub:owner,head:0},[reader]:{pub:reader,epub:reader,head:0}}};
test("atomic group authority preserves independent cancellation and exact named keys",()=>{
  const held=parseMediaGroupAuthority(authority,object,owner);assert.deepEqual(held,authority);
  assert.equal(held.direct.entries[0].stated,0);assert.deepEqual(held.projection!.members,[reader]);
  held.bindings[owner].head=10;assert.equal(authority.bindings[owner].head,0);
  assert.equal(parseMediaGroupAuthority({...authority,policy:{...authority.policy,config:null}},object,owner).policy!.config,null);
  for(const projection of [null,{object,set:null,predicate:null,members:[],snapshot:null}])
    assert.equal(parseMediaGroupAuthority({...authority,projection,policy:null},object,owner).policy,null);
});
test("atomic authority refuses extra parties, policy key mismatch and malformed direct history",()=>{
  for(const bad of [null,{}, {...authority,extra:1},{...authority,owner:reader},{...authority,direct:null},
    {...authority,direct:{entries:Array(65).fill(directEntry)}},{...authority,direct:{entries:{}}},
    {...authority,bindings:null},{...authority,bindings:[]},{...authority,bindings:{}},
    {...authority,bindings:{...authority.bindings,extra:authority.bindings[owner]}},
    {...authority,policy:null},{...authority,projection:null},{...authority,policy:{extra:1}},
    {...authority,policy:{...authority.policy,context:{...policyView.context,ownerPub:reader}}},
    {...authority,direct:{entries:[directEntry,directEntry]}}])assert.throws(()=>parseMediaGroupAuthority(bad,object,owner));
  assert.throws(()=>parseMediaGroupAuthority(authority,object,reader));
  for(const patch of [{extra:1},{accessor:"bad"},{grantRevision:0},{grantRevision:1.5},{stated:2},{from:-1},{until:0},
    {scope:"same-group"},{setId:set},{hamState:1}])
    assert.throws(()=>parseMediaGroupAuthority({...authority,direct:{entries:[{...directEntry,...patch}]}},object,owner));
  for(const patch of [{extra:1},{pub:"bad"},{pub:1},{epub:"bad"},{epub:1},{head:-1}])
    assert.throws(()=>parseMediaGroupAuthority({...authority,bindings:{...authority.bindings,[reader]:{...authority.bindings[reader],...patch}}},object,owner));
});
test("atomic authority client and BFF keep fixed owner, freshness and session boundaries",async()=>{
  const client=createPrivateMediaOwner(async(url,init)=>{
    assert.ok(String(url).endsWith("group-authority-view"));assert.deepEqual(JSON.parse(String(init?.body)),{object});return Response.json(authority);
  },()=>100);
  assert.deepEqual(await client.groupAuthorityView(object,owner),authority);
  await assert.rejects(client.groupAuthorityView("bad",owner));await assert.rejects(client.groupAuthorityView(object,"bad"));
  await assert.rejects(client.groupAuthorityView(object,owner,AbortSignal.abort()));
  let tick=0;const stale=createPrivateMediaOwner(async()=>Response.json(authority),()=>tick++*5);
  await assert.rejects(stale.groupAuthorityView(object,owner),PrivateMediaConflict);
  const service=createMediaOwnerService(config,"https://s3r.ch",async()=>owner,async(url,init)=>{
    assert.ok(String(url).endsWith("group-authority-view"));assert.equal(new Headers(init?.headers).get("X-Api-Key"),"fixed-owner-key");return Response.json(authority);
  },()=>100);
  const result=await service("group-authority-view",request({object}));assert.equal(result.status,200);assert.deepEqual(await result.json(),authority);
  assert.equal((await service("group-authority-view",request({object,owner}))).status,400);
  const bad=createMediaOwnerService(config,"https://s3r.ch",async()=>owner,async()=>Response.json({...authority,bindings:{}}),()=>100);
  assert.equal((await bad("group-authority-view",request({object}))).status,403);
  let resolves=0;const changed=createMediaOwnerService(config,"https://s3r.ch",async()=>++resolves===1?owner:reader,async()=>Response.json(authority),()=>100);
  assert.equal((await changed("group-authority-view",request({object}))).status,403);
});

test("group reconciliation recognizes exact applied batches after a lost response",async()=>{
  let applied=false,writes=0;const sent:unknown[]=[];
  const client=createPrivateMediaOwner(async(url,init)=>{
    if(String(url).endsWith("group-check")){sent.push(JSON.parse(String(init?.body)));return Response.json({...appendState,state:applied?"applied":"absent"});}
    writes++;applied=true;throw Error("lost response after commit");
  },()=>100);
  assert.equal((await client.groupRowsState(object,draft)).state,"absent");
  await assert.rejects(client.appendGroupRows(object,draft));assert.equal(writes,1);
  assert.equal((await client.groupRowsState(object,draft)).state,"applied");
  await client.appendGroupRows(object,draft);assert.equal(writes,1);
  assert.ok(sent.every(body=>JSON.stringify(body)===JSON.stringify({object,...draft})));
  assert.deepEqual(parseMediaGroupWriteState(appendState),appendState);
  for(const bad of [null,{}, {...appendState,extra:1},{...appendState,at:-1},{...appendState,fence:"bad"},{...appendState,state:"unknown"}])
    assert.throws(()=>parseMediaGroupWriteState(bad));
  await assert.rejects(client.groupRowsState("bad",draft));
});
test("group-check BFF bounds signed batches, pins owner credential and rechecks session",async()=>{
  let calls=0;
  const service=createMediaOwnerService(config,"https://s3r.ch",async()=>owner,async(url,init)=>{
    calls++;assert.ok(String(url).endsWith("group-check"));assert.equal(new Headers(init?.headers).get("X-Api-Key"),"fixed-owner-key");
    assert.deepEqual(JSON.parse(String(init?.body)),{object,...draft});return Response.json(appendState);
  },()=>100);
  const result=await service("group-check",request({object,...draft}));assert.equal(result.status,200);assert.deepEqual(await result.json(),appendState);
  for(const body of [{object,...draft,at:100},{object,...draft,owner},{object,...draft,rows:[]},{object,...draft,set:"bad"}])
    assert.equal((await service("group-check",request(body))).status,400);
  assert.equal(calls,1);
  const invalid=createMediaOwnerService(config,"https://s3r.ch",async()=>owner,async()=>Response.json({...appendState,state:"unknown"}),()=>100);
  assert.equal((await invalid("group-check",request({object,...draft}))).status,403);
  let count=0;const changed=createMediaOwnerService(config,"https://s3r.ch",async()=>++count===1?owner:reader,async()=>Response.json(appendState),()=>100);
  assert.equal((await changed("group-check",request({object,...draft}))).status,403);
});
