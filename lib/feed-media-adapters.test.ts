import test from "node:test";
import assert from "node:assert/strict";
import { activityPubMedia, atprotoMedia, farcasterMedia, nostrMedia } from "./feed-media-adapters";
import { parseFeedMedia } from "./feed-media";
import { parseRssAtom } from "./rss-atom";

test("public media copies only bounded public fields", () => {
  assert.deepEqual(parseFeedMedia([{kind:"image",url:"https://example.com/a.png",key:"secret",wrap:"secret"}]), [{kind:"image",url:"https://example.com/a.png"}]);
  for (const url of ["http://127.0.0.1/a", "http://169.254.169.254/a", "https://user:pass@example.com/a", "javascript:alert(1)"])
    assert.deepEqual(parseFeedMedia([{kind:"image",url}]), []);
  assert.deepEqual(parseFeedMedia(Array(9).fill({kind:"image",url:"https://example.com/a"})), []);
  assert.deepEqual(parseFeedMedia("{"), []);
});
test("Bluesky maps images, video, link cards and quotes", () => {
  assert.equal(atprotoMedia({$type:"app.bsky.embed.images#view",images:[{fullsize:"https://example.com/a.png",alt:"Alt",aspectRatio:{width:640,height:480}}]})[0].alt,"Alt");
  assert.equal(atprotoMedia({$type:"app.bsky.embed.video#view",playlist:"https://example.com/a.m3u8"})[0].kind,"video");
  assert.equal(atprotoMedia({$type:"app.bsky.embed.external#view",external:{uri:"https://example.com/",title:"Card"}})[0].title,"Card");
  assert.equal(atprotoMedia({$type:"app.bsky.embed.record#view",record:{uri:"at://did:plc:abc/app.bsky.feed.post/123",author:{handle:"alice.test"},value:{text:"Quote"}}})[0].kind,"quote");
  assert.deepEqual(atprotoMedia({$type:"unknown",images:[]}),[]);
});
test("ActivityPub carries warning and accessible attachment name", () => {
  const media=activityPubMedia({sensitive:true,summary:"Warning",attachment:[{mediaType:"audio/mpeg",url:"https://example.com/a",name:"Interview"}]});
  assert.equal(media[0].kind,"audio"); assert.equal(media[0].alt,"Interview"); assert.equal(media[0].warning,"Warning");
});
test("Farcaster maps media URLs and quoted casts", () => {
  assert.equal(farcasterMedia([{url:"https://example.com/a.mp4"}])[0].kind,"video");
  assert.equal(farcasterMedia([{castId:{hash:"ab".repeat(20)}}])[0].kind,"quote");
});
test("Nostr imeta preserves dimensions and does not treat replies as quotes", () => {
  const media=nostrMedia([["imeta","url https://example.com/a.png","m image/png","dim 640x480","alt Example"],["e","ab".repeat(32)]]);
  assert.equal(media.length,1); assert.equal(media[0].width,640); assert.equal(media[0].alt,"Example");
});
test("RSS and Atom preserve enclosures and media content", () => {
  assert.equal(parseRssAtom('<rss><channel><item><guid>one</guid><enclosure url="https://example.com/a.mp3" type="audio/mpeg"/></item></channel></rss>',"https://example.com/feed").items[0].media?.[0].kind,"audio");
  assert.equal(parseRssAtom('<feed><entry><id>one</id><link rel="enclosure" href="https://example.com/a.mp4" type="video/mp4"/></entry></feed>',"https://example.com/feed").items[0].media?.[0].kind,"video");
});

test("Gun v1 preserves additive media and rejects future versions", async () => {
  const { toGunNode, fromGunNode } = await import("./feed-types");
  const item={id:"one",source:"atproto" as const,kind:"social",author:"Alice",body:"Text",ts:1,permalink:"https://example.com/one",tags:[],provenance:"fixture",media:[{kind:"image" as const,url:"https://example.com/a.png"}]};
  const encoded=toGunNode(item);
  assert.equal(encoded.v,1); assert.equal(typeof encoded.media,"string");
  assert.deepEqual(fromGunNode(encoded)?.media,item.media);
  const {media: _ignored, ...legacy}=encoded;
  assert.equal(fromGunNode(legacy)?.body,"Text");
  assert.equal(fromGunNode({...encoded,v:999}),null);
  assert.equal(fromGunNode({...encoded,media:"{"})?.body,"Text");
});
