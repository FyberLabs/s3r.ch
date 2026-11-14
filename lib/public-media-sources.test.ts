import test from "node:test";
import assert from "node:assert/strict";
import {publicMediaSourceAdmission} from "./public-media-sources";
import type {FeedItem} from "./feed-types";
const key="x".repeat(32),url="https://example.com/live.m3u8";
const request=(target=url,kind="video")=>new Request(`https://s3r.ch/api/feed/media?${new URLSearchParams({url:target,kind})}`);
const stream={id:"live",author:"publisher",title:"Live",url,thumbnail:"https://example.com/poster.png",starts:1,expires:9999999999};
const broken=async()=>{throw Error("private upstream detail");};
test("live media remains admitted when the independent feed snapshot fails",async()=>{
 assert.ok(await publicMediaSourceAdmission(request(),key,broken,async()=>({available:true,streams:[stream]})));
 assert.ok(await publicMediaSourceAdmission(request(stream.thumbnail,"image"),key,broken,async()=>({available:true,streams:[stream]})));
 const sign=await publicMediaSourceAdmission(request(),key,async()=>[],async()=>({available:true,streams:[stream]}));assert.ok(sign);
 const child=new Request("https://s3r.ch"+sign("https://example.com/segment.ts","video",1));
 assert.ok(await publicMediaSourceAdmission(child,key,broken,async()=>({available:true,streams:[stream]})));
 assert.equal(await publicMediaSourceAdmission(child,key,async()=>[],async()=>({available:true,streams:[]})),null);
});
test("configuration, independent failures and unadmitted URLs fail closed",async()=>{
 let calls=0;await assert.rejects(publicMediaSourceAdmission(request(),"short",async()=>{calls++;return [];},async()=>{calls++;return {available:true,streams:[]};}));assert.equal(calls,0);
 await assert.rejects(publicMediaSourceAdmission(request(),key,broken,broken),/Public media sources unavailable/);
 await assert.rejects(publicMediaSourceAdmission(request(),key,async()=>[],async()=>({available:false,streams:[]})),/Public media sources unavailable/);
 assert.equal(await publicMediaSourceAdmission(request("https://attacker.example/x"),key,async()=>[],async()=>({available:true,streams:[stream]})),null);
 const row={id:"cached",source:"nostr",kind:"social",author:"a",body:"",ts:1,permalink:"",tags:[],provenance:"fixture",media:[{kind:"video",url}]} as FeedItem;
 assert.ok(await publicMediaSourceAdmission(request(),key,async()=>[row],broken));
});
