// Synthetic crypto material for the CI-only Granted browser harness.
import {prepareMediaFile} from "../lib/media-file";
import {shareDigest} from "../lib/media-share-journal";
import {wrapGroupKeyToMembers} from "sociacl-ids/group-reader-wrap";
import {wrapItemDekToGroupEpoch} from "sociacl-ids/group-wrap";
export async function groupFixture(bytes:Uint8Array,description:{name:string;mediaType:string},tenant:string,object:string,reader:{pub:string;epub:string}){
 const set=object.replace('media_','set_'),predicate='same-group',groupKey=crypto.getRandomValues(new Uint8Array(32));
 const sealed=await prepareMediaFile(bytes,description,{tenant,object});
 try{
  const key=await wrapGroupKeyToMembers(groupKey,{group:set,epoch:3,revisionId:'c'.repeat(64)},[{account:reader.pub,pub:reader.pub,identityPub:reader.pub,epub:reader.epub}],[reader.pub]);
  const item=await wrapItemDekToGroupEpoch(sealed.key,groupKey,{object,group:set,epoch:2,revisionId:'a'.repeat(64)});
  if(!key.ok||!item.ok)throw Error('Group fixture unavailable');
  const commitment=await shareDigest(groupKey),encode=(value:unknown)=>btoa(JSON.stringify(value));
  return {bytes:Array.from(sealed.bytes),sha256:sealed.sha256,
   entry:{object,predicate,set},
   group:{payload:encode(key.value[0]),predicate,set_id:set,epoch:3,revision_id:'c'.repeat(64),reader_epub:reader.epub,key_commitment:commitment},
   item:{payload:encode({wrap:item.value,reference:{sha256:sealed.sha256,length:sealed.bytes.length}}),object,predicate,set_id:set,item_epoch:2,item_revision_id:'a'.repeat(64),item_digest:sealed.sha256,group_epoch:3,group_revision_id:'c'.repeat(64),group_key_commitment:commitment}};
 }finally{sealed.key.fill(0);groupKey.fill(0);}
}
