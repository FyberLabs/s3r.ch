import test from "node:test";
import assert from "node:assert/strict";
import { parseForumFile } from "./forum";
import { parseLinkFile } from "../identity-link-schema.cjs";
import { GET as version } from "../app/api/version/route";

test("version-one identity documents preserve known additive fields across round trips",()=>{
  const owner="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
  const legacy={v:1,people:[{owner,handles:[{kind:"wallet",address:owner}]}]};
  const expanded={...legacy,people:[{...legacy.people[0],ageConfirmedAt:"2026-01-01T00:00:00.000Z"}],
    oauthAge:[{sub:"fixture",confirmedAt:"2026-01-01T00:00:00.000Z"}],providerIssuers:{github:"https://id.example/realm"}};
  for(const document of [legacy,expanded]){
    const first=parseLinkFile(document);assert.equal(first.ok,true);if(!first.ok)throw Error();
    assert.deepEqual(first.file,document);assert.deepEqual(parseLinkFile(JSON.parse(JSON.stringify(first.file))),first);
  }
  assert.deepEqual(parseLinkFile({...legacy,v:2}),{ok:false,reason:"unknown-version"});
});
test("legacy forum v1 fills additive arrays while expanded v1 remains stable",()=>{
  const legacy={v:1,channels:[],bots:[],memberships:[],messages:[]};
  const expanded={...legacy,invites:[],groups:[],groupMembers:[],desktops:[]};
  const first=parseForumFile(legacy);assert.equal(first.ok,true);if(!first.ok)throw Error();
  assert.deepEqual(first.file,expanded);assert.deepEqual(parseForumFile(expanded),first);
  assert.deepEqual(parseForumFile({...expanded,v:2}),{ok:false,reason:"unknown-version"});
});
test("version probe reports only the configured immutable build revision",async()=>{
  const saved=process.env.APP_BUILD_REVISION;
  try{
    for(const value of ["a".repeat(40),"main","private", "A".repeat(40),""]){
      process.env.APP_BUILD_REVISION=value;const response=version();
      assert.equal(response.headers.get("cache-control"),"no-store");
      assert.deepEqual(await response.json(),{revision:value==="a".repeat(40)?value:null});
    }
  }finally{if(saved===undefined)delete process.env.APP_BUILD_REVISION;else process.env.APP_BUILD_REVISION=saved;}
});
