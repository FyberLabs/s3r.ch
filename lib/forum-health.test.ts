import test from 'node:test';
import assert from 'node:assert/strict';
import { createForumHealth } from './forum-health';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('health returns immediately, coalesces slow probes, expires stale success and recovers', async () => {
  let now=0,calls=0,done:(value:boolean)=>void=()=>{};
  const health=createForumHealth(()=>{calls++;return new Promise(resolve=>{done=resolve;});},()=>now);
  assert.equal(health().status,'unavailable');await tick();
  for(let i=0;i<100;i++)assert.equal(health().status,'unavailable');
  assert.equal(calls,1);done(true);await tick();assert.equal(health().status,'ok');
  now=16000;assert.equal(health().status,'ok');await tick();assert.equal(calls,2);
  now=31000;assert.equal(health().status,'unavailable');done(false);await tick();
  now=47000;assert.equal(health().status,'unavailable');await tick();done(true);await tick();
  assert.equal(health().status,'ok');
});
