import test from "node:test";
import assert from "node:assert/strict";
import {activityPubReply,atprotoReply,farcasterReply,nostrReply,parseFeedReference} from "./feed-reply";
import {fromGunNode,toGunNode,type FeedItem} from "./feed-types";
import {itemUnshareTombstone} from "./unshare";
test("Bluesky preserves parent/root identifiers and supplied parent author",()=>{
 const parent={uri:"at://did:plc:parent/app.bsky.feed.post/one"},root={uri:"at://did:plc:root/app.bsky.feed.post/two"};
 const result=atprotoReply({parent,root},{parent:{author:{handle:"alice.test"}}});
 assert.equal(result.replyTo?.id,parent.uri);assert.equal(result.replyTo?.author,"alice.test");assert.equal(result.root?.id,root.uri);
 assert.deepEqual(atprotoReply({parent:{uri:"at://x/app.bsky.feed.post/\ud800"}}),{});
});
test("Farcaster and ActivityPub retain public parent references",()=>{
 const hash="ab".repeat(20);assert.equal(farcasterReply({parentCastId:{hash}}).replyTo?.id,"0x"+hash);
 assert.equal(farcasterReply({parentUrl:"https://example.com/post"}).replyTo?.permalink,"https://example.com/post");
 const result=activityPubReply({inReplyTo:"https://example.com/parent",context:{id:"https://example.com/root"}});
 assert.equal(result.replyTo?.id,"https://example.com/parent");assert.equal(result.root?.id,"https://example.com/root");
 assert.deepEqual(activityPubReply({inReplyTo:"http://127.0.0.1/secret"}),{});
});
test("Nostr prefers explicit root/reply markers and excludes mentions",()=>{
 const root="ab".repeat(32),parent="cd".repeat(32),mention="ef".repeat(32);
 const result=nostrReply([["e",root,"","root"],["e",mention,"","mention"],["e",parent,"","reply"]]);
 assert.equal(result.root?.id,root);assert.equal(result.replyTo?.id,parent);
 assert.equal(nostrReply([["e",root],["e",parent]]).replyTo?.id,parent);
 assert.deepEqual(nostrReply([["e",mention,"","mention"]]),{});
});
test("reply references are additive, bounded and explicitly removed on updates",()=>{
 const reference={id:"parent",permalink:"https://example.com/parent",author:"Alice"};
 assert.deepEqual(parseFeedReference(JSON.stringify(reference)),reference);
 for(const value of [null,"{",{},"x".repeat(8193),{...reference,id:"x".repeat(2049)},{...reference,permalink:"javascript:alert(1)"}])assert.equal(parseFeedReference(value),null);
 const item:FeedItem={id:"one",source:"rss",kind:"post",author:"Alice",body:"Reply",ts:1,permalink:"https://example.com/one",tags:[],provenance:"fixture",replyTo:reference};
 const node=toGunNode(item);assert.deepEqual(fromGunNode(node)?.replyTo,reference);
 const {replyTo:_ignored,...without}=item;
 assert.equal(fromGunNode({...node,...toGunNode(without)})?.replyTo,undefined);
 assert.equal(itemUnshareTombstone("one").replyTo,null);assert.equal(itemUnshareTombstone("one").root,null);
});
test("object references obey the same serialized bound as Gun strings",()=>{
 const reference={id:"x"+"\u0001".repeat(2047),permalink:"https://example.com/parent"};
 assert.equal(parseFeedReference(reference),null);assert.equal(parseFeedReference(JSON.stringify(reference)),null);
});
test("malformed source references and optional author fields fail closed",()=>{
 for(const parse of [activityPubReply,atprotoReply,farcasterReply,nostrReply])assert.deepEqual(parse(null),{});
 assert.deepEqual(atprotoReply({parent:{uri:"bad"}}),{});
 assert.deepEqual(atprotoReply({parent:{uri:42}}),{});
 assert.equal(farcasterReply({parentHash:"0x"+"ab".repeat(20)}).replyTo?.id,"0x"+"ab".repeat(20));
 assert.equal(nostrReply([["e","ab".repeat(32),"","root"]]).replyTo?.id,"ab".repeat(32));
 assert.equal(parseFeedReference({id:"p",permalink:"https://example.com/p",author:"x".repeat(257)})?.author,undefined);
 assert.equal(parseFeedReference({id:" ",permalink:"https://example.com/p"}),null);
});
