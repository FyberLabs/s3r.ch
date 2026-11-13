import test from "node:test";
import assert from "node:assert/strict";
import { parseMediaCatalogPage, isMediaCatalogPageNumber } from "./media-catalog";
const owner="axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";
const object="media_p_6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5_11111111111111111111111111111111";
test("catalog fixed pagination and canonical owner scope",()=>{
  const value={at:1,objects:[object],nextPage:1};
  assert.deepEqual(parseMediaCatalogPage(value,0,owner),value);
  assert.deepEqual(parseMediaCatalogPage({at:1,objects:[],nextPage:null},15,owner),{at:1,objects:[],nextPage:null});
  for(const page of [null,true,-1,16,0.5,Infinity,"0"])assert.equal(isMediaCatalogPageNumber(page),false);
  for(const bad of [null,[],{}, {...value,at:-1},{...value,at:NaN},{...value,nextPage:null},
    {...value,objects:null},{...value,objects:[object,object]},{...value,objects:[3]},
    {...value,objects:[object.replace("media_","photo_")]},{...value,objects:["media_bad"]},
    {...value,objects:new Array(5).fill(object)},{...value,extra:true}])assert.throws(()=>parseMediaCatalogPage(bad,0,owner));
  assert.throws(()=>parseMediaCatalogPage(value,16,owner));
  assert.throws(()=>parseMediaCatalogPage(value,0,"other"));
  const copy=parseMediaCatalogPage(value,0,owner);copy.objects.length=0;assert.equal(value.objects.length,1);
});
