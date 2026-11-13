import test from "node:test";
import assert from "node:assert/strict";
import {mediaAdmission,createMediaBudget} from "./public-media-admission";
import type {FeedItem} from "./feed-types";
const key="fixture-secret-".repeat(4),root="https://example.com/video.m3u8";
const items=[{media:[{kind:"video",url:root,thumbnail:"https://example.com/thumb.png"}]}] as FeedItem[];
const request=(path:string)=>new Request(new URL(path,"https://s3r.ch"));
test("only admitted attachments or signed children can use the fetch route",()=>{
 const admit=mediaAdmission(key,items,1000);
 assert.equal(admit(request("/api/feed/media?url=https://attacker.example/a&kind=video")),null);
 const sign=admit(request(`/api/feed/media?${new URLSearchParams({url:root,kind:"video"})}`));assert.ok(sign);
 const child=sign("https://example.com/segment.ts","video",1);assert.ok(admit(request(child)));
 assert.equal(admit(request(child.replace("segment.ts","other.ts"))),null);
 assert.equal(mediaAdmission(key,[],1000)(request(child)),null);
 assert.equal(mediaAdmission(key,items,3601001)(request(child)),null);
 assert.equal(admit(request("/api/feed/media?url=https://example.com/a&kind=video&depth=1")),null);
 assert.throws(()=>mediaAdmission("",items));
});
test("aggregate request and byte quotas apply across callers and reset by window",()=>{
 let now=1;const quota=createMediaBudget(2,4,()=>now);
 assert.equal(quota.request(),true);assert.equal(quota.request(),true);assert.equal(quota.request(),false);
 assert.equal(quota.bytes(3),true);assert.equal(quota.bytes(2),false);assert.equal(quota.bytes(1),true);
 now=60001;assert.equal(quota.request(),true);assert.equal(quota.bytes(4),true);
});
