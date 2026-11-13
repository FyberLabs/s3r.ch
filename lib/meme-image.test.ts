import test from "node:test";
import assert from "node:assert/strict";
import {rasterDimensions,captionLines,drawMeme,MEME_FILE_MAX} from "./meme-image";
function png(w=640,h=480){const bytes=new Uint8Array(24);bytes.set([137,80,78,71,13,10,26,10]);const view=new DataView(bytes.buffer);view.setUint32(8,13);view.setUint32(12,0x49484452);view.setUint32(16,w);view.setUint32(20,h);return bytes;}
test("raster headers bound dimensions before browser decoding",()=>{
 assert.deepEqual(rasterDimensions(png()),{width:640,height:480,type:"image/png"});
 for(const marker of [192,193,194])assert.deepEqual(rasterDimensions(new Uint8Array([255,216,255,255,224,0,2,255,marker,0,8,8,1,224,2,128,3])),{width:640,height:480,type:"image/jpeg"});
 for(const bytes of [new Uint8Array(),new Uint8Array(MEME_FILE_MAX+1),png(0),png(4097),png(20,4097),new TextEncoder().encode('<svg/>'),new Uint8Array([255,216]),new Uint8Array([255,216,0,0,0,0]),new Uint8Array([255,216,255,218,0,2]),new Uint8Array([255,216,255,224,0,1]),new Uint8Array([255,216,255,224,0,50]),new Uint8Array([255,216,255,255,255,255])])assert.throws(()=>rasterDimensions(bytes));
});
test("captions wrap bounded Unicode text without evaluating markup",()=>{
 assert.deepEqual(captionLines("hello world",5,s=>Array.from(s).length),["hello","world"]);
 assert.deepEqual(captionLines("😀😀😀",2,s=>Array.from(s).length),["😀😀","😀"]);
 assert.deepEqual(captionLines("   ",10,s=>s.length),[]);
 assert.deepEqual(captionLines("<script>",20,s=>s.length),["<script>"]);
 for(const value of ["x".repeat(161),"a\nb","\ud800"])assert.throws(()=>captionLines(value,20,s=>s.length));
 assert.throws(()=>captionLines("W",1,()=>2));
});
function canvas(){const calls:string[]=[];const context={font:"",fillRect(){calls.push("fill");},drawImage(){calls.push("image");},measureText(text:string){return {width:text.length*8};},fillText(text:string){calls.push(text);},strokeText(){calls.push("stroke");}};return {calls,element:{width:0,height:0,getContext:()=>context} as unknown as HTMLCanvasElement};}
test("templates render captions over bounded raster output",()=>{
 for(const layout of ["overlay","panel"] as const)for(const background of ["dark","light"] as const){
  const c=canvas();drawMeme(c.element,null,"Top","Bottom",layout,background);assert.equal(c.element.width,1280);assert.ok(c.calls.includes("Top"));assert.ok(c.calls.includes("Bottom"));assert.ok(c.calls.includes("stroke"));
 }
 const c=canvas();drawMeme(c.element,{width:4096,height:2048} as ImageBitmap,"","","overlay","dark");assert.equal(c.element.width,1600);assert.equal(c.element.height,800);assert.ok(c.calls.includes("image"));
 for(const [width,height] of [[1,4096],[4096,1]]){drawMeme(c.element,{width,height} as ImageBitmap,"","","overlay","dark");assert.ok(c.element.width>=1);assert.ok(c.element.height>=1);}
 for(const top of [""," ","Wide image"]){drawMeme(c.element,{width:4096,height:512} as ImageBitmap,top,"","overlay","dark");assert.equal(c.element.height,200);}
 assert.throws(()=>drawMeme(c.element,{width:5000,height:1} as ImageBitmap,"","","overlay","dark"));
 assert.throws(()=>drawMeme(c.element,null,"","","bad" as never,"dark"));
 assert.throws(()=>drawMeme(c.element,null,"","","overlay","bad" as never));
 assert.throws(()=>drawMeme({getContext:()=>null} as unknown as HTMLCanvasElement,null,"","","overlay","dark"));
 assert.throws(()=>drawMeme(c.element,{width:100,height:30} as ImageBitmap,"x".repeat(160),"","overlay","dark"));
});

test("panel bottom captions cannot spill out of the image into the top caption",()=>{
 const c=canvas(),image={width:300,height:30} as ImageBitmap;
 drawMeme(c.element,image,"x".repeat(160),"","panel","dark");
 assert.throws(()=>drawMeme(c.element,image,"x".repeat(160),"x".repeat(160),"panel","dark"),/Shorten the caption/);
});
