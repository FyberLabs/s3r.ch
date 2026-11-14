import test from "node:test";
import assert from "node:assert/strict";
import {boundedNostrFilter,matchesNostrFilter,type NostrFilter} from "./nostr-filter";
const id="a".repeat(64),pubkey="b".repeat(64),other="c".repeat(64);
test("bounded selectors are copied, normalized and conjunctive",()=>{
 const input={authors:[pubkey.toUpperCase()],ids:[id.toUpperCase()],"#e":[other.toUpperCase()],kinds:[1],limit:17};
 const filter=boundedNostrFilter(input);input.authors[0]=other;input.ids[0]=other;input.kinds[0]=2;
 assert.deepEqual(filter,{authors:[pubkey],ids:[id],"#e":[other],kinds:[1],limit:17});
 const event={id,pubkey,kind:1,tags:[["e",other]]};assert.equal(matchesNostrFilter(event,filter),true);
 for(const change of [{pubkey:other},{id:other},{id:undefined},{kind:2},{kind:"1"},{pubkey:null},{tags:[]},{tags:null},{tags:Array(129).fill(["e",other])},{tags:[null,["p",other],["e",123]]}])assert.equal(matchesNostrFilter({...event,...change},filter),false);
 assert.equal(matchesNostrFilter(event,boundedNostrFilter({ids:[id],kinds:[1],limit:1})),true);
 assert.equal(matchesNostrFilter(event,boundedNostrFilter({"#e":[other],kinds:[1],limit:1})),true);
 assert.equal(matchesNostrFilter(event,boundedNostrFilter({authors:[pubkey],kinds:[1],limit:1})),true);
});
test("empty, malformed or oversized selectors and limits cannot open broad queries",()=>{
 for(const value of [{kinds:[1],limit:1},{authors:[],kinds:[1],limit:1},{ids:["bad"],kinds:[1],limit:1},{"#e":Array(17).fill(id),kinds:[1],limit:1},{ids:[id],kinds:[],limit:1},{ids:[id],kinds:Array(9).fill(1),limit:1},{ids:[id],kinds:[65536],limit:1},{ids:[id],kinds:[NaN],limit:1},{ids:[id],kinds:[-1],limit:1},{ids:[id],kinds:[1],limit:0},{ids:[id],kinds:[1],limit:101},{ids:[id],kinds:[1],limit:NaN}])assert.throws(()=>boundedNostrFilter(value as NostrFilter),/Invalid Nostr/);
});
