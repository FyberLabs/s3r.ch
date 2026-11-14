import test from "node:test";
import assert from "node:assert/strict";
import {fetchNostrConversation} from "./nostr-conversation";
import {nostrAnchor,nostrEvents,nostrChild,nostrParent,nostrRoot,signedThreadNote} from "../scripts/fixtures/nostr-thread-data";
import type {NostrFilter} from "./nostr-filter";
const select=(filter:NostrFilter)=>nostrEvents.filter(event=>filter.ids?filter.ids.includes(event.id):event.tags.some(tag=>tag[0]==="e"&&filter["#e"]?.includes(tag[1])));
test("authenticated exact-ID ancestors and direct replies form a connected thread",async()=>{
 const filters:NostrFilter[]=[];const result=await fetchNostrConversation(nostrAnchor,async(_relay,filter)=>{filters.push(filter);return select(filter);});
 assert.deepEqual(result.rows.map(row=>row.body),["Public child","Provider parent","Provider root","Provider reply"]);assert.equal(result.truncated,false);assert.equal(filters.length,4);assert.deepEqual(filters[0].ids,[nostrChild.id]);
});
test("forged, unrelated, malformed or missing events never enter the thread",async()=>{
 for(const raw of [null,{}, {...nostrChild,content:"forged"},nostrRoot])assert.deepEqual((await fetchNostrConversation(nostrAnchor,async()=>[raw])).rows,[]);
 assert.deepEqual((await fetchNostrConversation({...nostrAnchor,source:"atproto"},async()=>{assert.fail("no relay");})).rows,[]);
 assert.deepEqual((await fetchNostrConversation({...nostrAnchor,id:"invalid"},async()=>{assert.fail("no relay");})).rows,[]);
 const result=await fetchNostrConversation(nostrAnchor,async(_relay,filter)=>filter.ids?.[0]===nostrChild.id?[nostrChild]:filter.ids?[]:[nostrRoot,nostrChild]);assert.equal(result.rows.length,1);
 await assert.rejects(fetchNostrConversation(nostrAnchor,async()=>{throw Error("offline");}));
 await assert.rejects(fetchNostrConversation(nostrAnchor,async()=>[nostrChild,nostrChild]),/exceeds limit/);
 const partial=await fetchNostrConversation(nostrAnchor,async(_relay,filter)=>{if(filter.ids?.[0]===nostrChild.id)return [nostrChild];throw Error("unavailable");});assert.equal(partial.rows.length,1);
});
test("depth, reply count, duplicates and start deadline stay bounded",async()=>{
 let parent=signedThreadNote("root");const chain=[parent];for(let n=0;n<10;n++){parent=signedThreadNote(`depth${n}`,parent.id);chain.push(parent);}
 const anchor={...nostrAnchor,id:parent.id};const replies=Array.from({length:17},(_,n)=>signedThreadNote(`reply${n}`,anchor.id));
 const result=await fetchNostrConversation(anchor,async(_relay,filter)=>filter.ids?chain.filter(event=>filter.ids!.includes(event.id)):replies);assert.equal(result.rows.length,26);assert.equal(result.truncated,true);
 const duplicate=await fetchNostrConversation(nostrAnchor,async(_relay,filter)=>filter.ids?select(filter):[...select(filter),...select(filter)]);assert.equal(duplicate.rows.length,4);
 let now=123_000;const timed=await fetchNostrConversation(nostrAnchor,async()=>{now=138_000;return [nostrChild];},()=>now);assert.equal(timed.rows.length,1);assert.equal(timed.truncated,true);
 const invalidParent=signedThreadNote("bad parent","invalid");assert.equal((await fetchNostrConversation({...nostrAnchor,id:invalidParent.id},async(_relay,filter)=>filter.ids?[invalidParent]:[])).rows.length,1);
});
