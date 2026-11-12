import test from "node:test";
import assert from "node:assert/strict";
import { createSeaIdentityActivation } from "./sea-identity-activation";
import type { SeaPair } from "./sea";
const pair = { pub:"one",priv:"private",epub:"enc",epriv:"secret" } as SeaPair;

test("activation requires an existing unlocked key and never creates or links one", async () => {
  let calls = 0;
  const client = {signIn:async()=>{calls++;return true;},logout:async()=>true};
  assert.equal(await createSeaIdentityActivation({current:()=>null,client}).activate(),"locked");
  assert.equal(calls,0);
  assert.equal(await createSeaIdentityActivation({current:()=>({pair,revision:1}),client}).activate(),"ready");
  assert.equal(calls,1);
});

test("changed, replaced and locked keys clear an in-flight session before another activation", async () => {
  for (const change of [null,{pair,revision:2},{pair:{...pair,pub:"two"},revision:1}]) {
    let current: {pair:SeaPair;revision:number}|null = {pair,revision:1}, clears = 0;
    let release!:()=>void, entered!:()=>void;
    const held=new Promise<void>(resolve=>{release=resolve;}), started=new Promise<void>(resolve=>{entered=resolve;});
    const activation=createSeaIdentityActivation({current:()=>current,client:{
      signIn:async selected=>{assert.notEqual(selected,pair);current=change;return true;},
      logout:async signal=>{assert.ok(signal);clears++;entered();await held;return true;},
    }});
    const pending=activation.activate();await started;
    assert.equal(await activation.activate(),"unavailable");release();
    assert.equal(await pending,"changed");assert.equal(clears,1);
  }
});

test("failed proof and cleanup errors never report an active identity", async () => {
  const current=()=>({pair,revision:1});
  assert.equal(await createSeaIdentityActivation({current,client:{signIn:async()=>false,logout:async()=>true}}).activate(),"unavailable");
  const activation=createSeaIdentityActivation({current,client:{signIn:async()=>{throw Error("offline");},logout:async()=>true}});
  assert.equal(await activation.activate(),"unavailable");assert.equal(await activation.activate(),"unavailable");
  let changed=false;
  assert.equal(await createSeaIdentityActivation({current:()=>changed?null:current(),client:{signIn:async()=>{changed=true;return true;},logout:async()=>{throw Error("offline");}}}).activate(),"unavailable");
});
