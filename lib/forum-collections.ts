import {parseMediaGroupScope,type MediaGroupScope} from './media-group';
import type {FeedItem} from './feed-types';
export const COLLECTION_PREFIX='s3rch-collection:v1:';
export type ForumCollection=MediaGroupScope & {label:string};
/** A signed forum reference is navigation, never a group or media grant. */
export function encodeForumCollection(input:ForumCollection){
  const scope=parseMediaGroupScope({predicate:input.predicate,set:input.set});
  if(typeof input.label!=='string'||!input.label.trim()||input.label!==input.label.trim()||input.label.length>40||
    !input.label.isWellFormed()||/[\u0000-\u001f\u007f]/u.test(input.label))throw Error('Invalid collection label');
  const body=COLLECTION_PREFIX+JSON.stringify([scope.predicate,scope.set,input.label]);
  if(body.length>280)throw Error('Collection reference too long');return body;
}
export function parseForumCollection(body:string):ForumCollection|null{
  if(typeof body!=='string'||body.length>280||!body.startsWith(COLLECTION_PREFIX))return null;
  try{const value=JSON.parse(body.slice(COLLECTION_PREFIX.length));if(!Array.isArray(value)||value.length!==3)return null;
    const result={predicate:value[0],set:value[1],label:value[2]};return encodeForumCollection(result)===body?result:null;
  }catch{return null;}
}
export const collectionKey=(scope:MediaGroupScope)=>JSON.stringify([scope.predicate,scope.set]);
/** Input must already have current forum, author and signature admission. */
export function forumCollections(rows:readonly FeedItem[]){
  const values=new Map<string,ForumCollection>();
  // The existing bounded chat order selects a label, not an authority revision.
  for(const row of rows){const value=parseForumCollection(row.body);if(value&&!values.has(collectionKey(value)))values.set(collectionKey(value),value);}
  return [...values.values()];
}
