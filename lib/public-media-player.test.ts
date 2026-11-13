import test from "node:test";
import assert from "node:assert/strict";
import type Hls from "hls.js";
import {attachPublicHls} from "./public-media-player";
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function video(native=false){return {src:"",canPlayType:()=>native?"probably":"",removeAttribute(this:{src:string}){this.src="";},load(){}} as unknown as HTMLVideoElement;}
test("native playback uses only the proxy and clears on unmount",()=>{
 const element=video(true);const controller=attachPublicHls(element,"/api/feed/media?url=fixture","https://s3r.ch",()=>assert.fail(),()=>{throw Error("must not import");});
 assert.match(element.src,/^\/api\/feed\/media/);controller.start();controller.destroy();controller.destroy();assert.equal(element.src,"");
});
test("HLS controller bounds requests, preserves early play and destroys once",async()=>{
 let config:Record<string,unknown>={},started=0,destroyed=0,failed=0,callback:(_event:string,data:{fatal:boolean})=>void=()=>{};
 class Fake {static isSupported=()=>true;static Events={ERROR:"error"};constructor(options:Record<string,unknown>){config=options;}on(_event:string,fn:typeof callback){callback=fn;}attachMedia(){}loadSource(source:string){assert.match(source,/^\/api\/feed/);}startLoad(){started++;}destroy(){destroyed++;}}
 const controller=attachPublicHls(video(),"/api/feed/media?url=fixture","https://s3r.ch",()=>failed++,async()=>({default:Fake as unknown as typeof Hls}));
 controller.start();await flush();assert.equal(started,1);assert.equal(config.autoStartLoad,false);
 const check=config.xhrSetup as (xhr:unknown,url:string)=>void;
 check({},"https://s3r.ch/api/feed/media?url=fixture");assert.throws(()=>check({},"https://tracker.example/a"));assert.throws(()=>check({},"/api/private"));
 callback("error",{fatal:false});assert.equal(failed,0);callback("error",{fatal:true});assert.equal(failed,1);
 controller.destroy();controller.destroy();controller.start();callback("error",{fatal:true});assert.equal(destroyed,1);assert.equal(failed,1);
});
test("removed players cannot be recreated by delayed imports",async()=>{
 let resolve!:(value:{default:typeof Hls})=>void;
 const controller=attachPublicHls(video(),"/api/feed/media","https://s3r.ch",()=>assert.fail(),()=>new Promise(done=>{resolve=done;}));
 controller.destroy();resolve({default:class {constructor(){assert.fail();}} as unknown as typeof Hls});await flush();
 let failures=0;attachPublicHls(video(),"/api/feed/media","https://s3r.ch",()=>failures++,async()=>{throw Error("load failed");});await flush();assert.equal(failures,1);
 attachPublicHls(video(),"/api/feed/media","https://s3r.ch",()=>failures++,async()=>({default:{isSupported:()=>false} as unknown as typeof Hls}));await flush();assert.equal(failures,2);
});
