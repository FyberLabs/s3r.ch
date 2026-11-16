// Pure shape units: no transport or crypto.
import test from "node:test";
import assert from "node:assert/strict";
import {parseGroupGrantedPage,parseGroupGrantedRequest} from "./media-group-item-catalog";
import {owner,reader,object,scope} from "./media-group-item-epoch-fixture";
const entry={object,...scope},page={at:100,entries:[entry],nextPage:1};
test("group Granted pages expose only scoped foreign IDs and bounded pagination",()=>{
 assert.deepEqual(parseGroupGrantedRequest({page:0},reader),{page:0});assert.deepEqual(parseGroupGrantedPage(page,0,reader,100),page);
 assert.deepEqual(parseGroupGrantedPage({at:100,entries:[],nextPage:null},15,reader,100).entries,[]);
});
test("catalog refuses injected readers, owners, duplicates and malformed scope",()=>{
 for(const input of [null,{page:0,reader},{page:true},{page:-1},{page:16},{page:0.5}])assert.throws(()=>parseGroupGrantedRequest(input,reader));
 assert.throws(()=>parseGroupGrantedRequest({page:0},'bad'));assert.throws(()=>parseGroupGrantedPage(page,0,owner,100));
 for(const changed of [{...entry,object:'bad'},{...entry,object:scope.set},{...entry,set:'bad'},{...entry,predicate:'bad'},{...entry,extra:1}])
  assert.throws(()=>parseGroupGrantedPage({...page,entries:[changed]},0,reader,100));
 for(const entries of [[entry,entry],Array(5).fill(entry),null])assert.throws(()=>parseGroupGrantedPage({...page,entries},0,reader,100));
});
test("stale and overbroad page replies cannot become Granted locators",()=>{
 for(const patch of [{at:95},{at:102},{at:-1},{at:true},{nextPage:2},{nextPage:null},{extra:1}])assert.throws(()=>parseGroupGrantedPage({...page,...patch},0,reader,100));
 assert.throws(()=>parseGroupGrantedPage(page,0,reader,NaN));assert.throws(()=>parseGroupGrantedPage(null,0,reader,100));
});
