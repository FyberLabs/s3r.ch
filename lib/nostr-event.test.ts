import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {schnorr} from "@noble/curves/secp256k1.js";
import {verifiedNostrEvent} from "./nostr-event";
const key=new Uint8Array(32);key[31]=3;
const pubkey=Buffer.from(schnorr.getPublicKey(key)).toString("hex"),now=1800000000;
function note(){const event={pubkey,created_at:0,kind:1,tags:[],content:"old public note"};
 const hash=createHash("sha256").update(JSON.stringify([0,pubkey,0,1,[],event.content])).digest();
 return {...event,id:hash.toString("hex"),sig:Buffer.from(schnorr.sign(hash,key,new Uint8Array(32))).toString("hex")};}
test("public notes authenticate without inheriting live-event expiry",async()=>{
 const event=note();assert.deepEqual(await verifiedNostrEvent(event,[pubkey],1,now),event);
 assert.equal(await verifiedNostrEvent(event,[pubkey],1,now,3600),null);
 assert.equal(await verifiedNostrEvent({...event,created_at:-1},[pubkey],1,now),null);
});
test("unavailable hashing fails closed",async t=>{
 t.mock.method(crypto.subtle,"digest",async()=>{throw Error("unavailable");});
 assert.equal(await verifiedNostrEvent(note(),[pubkey],1,now),null);
});

test("async verification returns a captured event, not mutable caller fields",async()=>{
 const raw=note(),expected=structuredClone(raw),pending=verifiedNostrEvent(raw,[pubkey],1,now);
 raw.content="forged after hashing";raw.tags.push(["injected"] as never);
 assert.deepEqual(await pending,expected);
});
