import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { composeNativePost, ownsNativePost } from "./compose";
import { composeUser, assembleMineUser, userObjectSoul } from "./users";
import { createMemoryUserOverlayStore } from "./identity/user-overlay";
const wallet="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
test("wallet and OIDC credentials cannot create owned feed or user records",async()=>{
  for(const address of [wallet,"oidc:issuer:subject", ""]) {
    assert.equal(composeNativePost({address,body:"text"}),null);
    assert.equal(composeUser({address}),null);
    assert.equal(assembleMineUser({address}),null);
    assert.equal(await createMemoryUserOverlayStore().get(address),null);
    assert.throws(()=>userObjectSoul(address),/SEA principal/);
    assert.equal(ownsNativePost({source:"s3rch",author:address},address),false);
  }
});
test("feed session and outbound admission never fall back to credential owners",()=>{
  for(const file of ["app/api/identity/session/route.ts","app/api/outbound/route.ts"]){
    const source=readFileSync(file,"utf8");
    assert.match(source,/readSeaRequestSession/);
    assert.doesNotMatch(source,/ownerForWallet|ownerForOAuth/);
  }
  const hook=readFileSync("components/useIdentitySession.ts","utf8");
  assert.doesNotMatch(hook,/session\.owner\s*\|\|\s*session\.address/);
  assert.match(hook,/isSeaPubkey\(session.owner\)/);
});
