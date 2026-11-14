import test from "node:test";
import assert from "node:assert/strict";
import {memeTags,tagMemePng,readMemePngTags} from "./meme-png-tags";
const png=()=>new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=","base64"));
test("PNG tags are bounded, normalized, replaceable and preserve image chunks",()=>{
 const original=png(),tagged=tagMemePng(original,[" Work ","work","😀","<tag>"]);
 assert.deepEqual(readMemePngTags(tagged),["work","😀","<tag>"]);
 assert.deepEqual(tagged.subarray(0,original.length-12),original.subarray(0,-12));
 assert.deepEqual(tagged.subarray(-12),original.subarray(-12));
 assert.deepEqual(readMemePngTags(tagMemePng(tagged,["new"])),["new"]);
 assert.deepEqual(readMemePngTags(tagMemePng(tagged,[])),[]);
 assert.deepEqual(memeTags([" a ","A",""]),["a"]);
 for(const tags of [null,{},[1],Array(13).fill("tag"),["a".repeat(41)],["a\nb"],["\ud800"]])assert.throws(()=>memeTags(tags));
});
test("malformed image or tag metadata is never exposed as tags",()=>{
 assert.deepEqual(readMemePngTags(png()),[]);
 const tagged=tagMemePng(png(),["private"]);tagged[tagged.length-17]^=1;
 assert.deepEqual(readMemePngTags(tagged),[]);
 for(const value of [new Uint8Array(),png().subarray(0,20),new Uint8Array([...png(),0]),new Uint8Array(63*1024*1024+1)]){
  assert.throws(()=>tagMemePng(value,[]));assert.deepEqual(readMemePngTags(value),[]);
 }
 const badLength=png();new DataView(badLength.buffer).setUint32(8,0xffffffff);assert.throws(()=>tagMemePng(badLength,[]));
 const badType=png();badType[12]=0;assert.throws(()=>tagMemePng(badType,[]));
 const wrongHeader=png();wrongHeader[12]=65;assert.throws(()=>tagMemePng(wrongHeader,[]));
});
test("duplicate, oversized and incomplete text chunks do not supply tags",()=>{
 const original=png(),tagged=tagMemePng(original,["tag"]),start=original.length-12;
 const chunk=tagged.subarray(start,tagged.length-12);
 const duplicate=new Uint8Array([...tagged.subarray(0,-12),...chunk,...tagged.subarray(-12)]);
 assert.deepEqual(readMemePngTags(duplicate),[]);
 const large=new Uint8Array(4112);new DataView(large.buffer).setUint32(0,4100);
 large.set(new TextEncoder().encode("tEXts3rch-tags\0"),4);
 assert.deepEqual(readMemePngTags(new Uint8Array([...original.subarray(0,-12),...large,...original.subarray(-12)])),[]);
 const incomplete=original.slice(0,-12);assert.throws(()=>tagMemePng(incomplete,[]));
});
