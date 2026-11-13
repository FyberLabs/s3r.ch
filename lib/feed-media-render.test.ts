import test from "node:test";
import assert from "node:assert/strict";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {activityPubMedia,atprotoMedia,farcasterMedia,nostrMedia} from "./feed-media-adapters";
import {parseRssAtom} from "./rss-atom";
import {fromGunNode,toGunNode,type FeedItem,type FeedSource} from "./feed-types";
import type {FeedMedia} from "./feed-media";
import PublicFeedMedia from "../components/PublicFeedMedia";

function render(source:FeedSource,media:FeedMedia[]) {
 const item:FeedItem={id:"fixture",source,kind:"social",author:"Author",body:"Post",ts:1,permalink:"https://example.com/post",tags:[],provenance:"fixture",media};
 const decoded=fromGunNode(toGunNode(item));assert.ok(decoded);assert.deepEqual(decoded.media,media);
 return renderToStaticMarkup(createElement(PublicFeedMedia,{media:decoded.media}));
}
function expectKind(source:FeedSource,media:FeedMedia[],kind:FeedMedia["kind"],alt?:string) {
 assert.equal(media[0]?.kind,kind,source);
 const html=render(source,media);
 assert.match(html,/Open original/);
 if(kind==="image"||kind==="audio"||kind==="video") {
  assert.match(html,new RegExp(`<${kind==="image"?"img":kind}\\b`));
  // Playlist sources attach in an effect; CI browser playback covers that path.
  if(media[0].playlist)assert.doesNotMatch(html,/src=/);
  else assert.match(html,/src="\/api\/feed\/media\?/);
  assert.doesNotMatch(html,/src="https:|autoplay/i);
 } else assert.match(html,/<blockquote/);
 if(alt)assert.ok(html.includes(alt),`${source} lost accessible text`);
}

test("provider media survives Gun storage into the shared component",()=>{
 for(const [kind,extension,mime] of [["image","png","image/png"],["video","mp4","video/mp4"],["audio","mp3","audio/mpeg"],["link","html","text/html"]] as const){
  const url=`https://example.com/fixture.${extension}`;
  expectKind("farcaster",farcasterMedia([{url}]),kind);
  expectKind("nostr",nostrMedia([["imeta",`url ${url}`,`m ${mime}`,"alt Accessible fixture"]]),kind,"Accessible fixture");
  expectKind("activitypub",activityPubMedia({attachment:[{url,mediaType:mime,name:"Accessible fixture"}]}),kind,"Accessible fixture");
  for(const source of ["rss","atom"] as const){
   const xml=source==="rss"?`<rss><channel><item><guid>one</guid><enclosure url="${url}" type="${mime}"/></item></channel></rss>`:`<feed><entry><id>one</id><link rel="enclosure" href="${url}" type="${mime}"/></entry></feed>`;
   expectKind(source,parseRssAtom(xml,"https://example.com/feed").items[0].media??[],kind);
  }
 }
 expectKind("atproto",atprotoMedia({$type:"app.bsky.embed.images#view",images:[{fullsize:"https://example.com/a.png",alt:"Bluesky image"}]}),"image","Bluesky image");
 expectKind("atproto",atprotoMedia({$type:"app.bsky.embed.video#view",playlist:"https://example.com/a.m3u8",alt:"Bluesky video"}),"video","Bluesky video");
 expectKind("atproto",atprotoMedia({$type:"app.bsky.embed.external#view",external:{uri:"https://example.com/page",title:"External card"}}),"link");
 expectKind("atproto",atprotoMedia({$type:"app.bsky.embed.record#view",record:{uri:"at://did:plc:abc/app.bsky.feed.post/one",author:{handle:"alice.test"},value:{text:"Quoted content"}}}),"quote");
 expectKind("farcaster",farcasterMedia([{castId:{hash:"ab".repeat(20)}}]),"quote");
 expectKind("nostr",nostrMedia([["q","ab".repeat(32)]]),"quote");
});

test("source warnings prevent resource loading after the storage round trip",()=>{
 const cases:[FeedSource,FeedMedia[]][]=[
  ["atproto",atprotoMedia({$type:"app.bsky.embed.images#view",images:[{fullsize:"https://example.com/a.png"}]},[{val:"nudity"}])],
  ["nostr",nostrMedia([["image","https://example.com/a.png"],["content-warning","Spoiler"]])],
  ["activitypub",activityPubMedia({sensitive:true,summary:"Spoiler",attachment:[{url:"https://example.com/a.png",mediaType:"image/png"}]})],
 ];
 for(const [source,media] of cases){
  const html=render(source,media);assert.match(html,/Show media/);assert.doesNotMatch(html,/<img|<audio|<video|src=|\/api\/feed\/media/);
 }
});
