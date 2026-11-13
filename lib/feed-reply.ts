import {publicMediaUrl} from "./feed-media";
export type FeedReference={id:string;permalink:string;author?:string};
const row=(value:unknown):Record<string,unknown>=>value && typeof value==="object" && !Array.isArray(value)?value as Record<string,unknown>:{};
export function parseFeedReference(value:unknown):FeedReference|null {
 if(typeof value==="string"){if(value.length>8192)return null;try{value=JSON.parse(value);}catch{return null;}}
 const item=row(value),permalink=publicMediaUrl(item.permalink);
 if(typeof item.id!=="string" || !item.id.trim() || item.id.length>2048 || !permalink)return null;
 const reference={id:item.id,permalink,...(typeof item.author==="string" && item.author.length<=256?{author:item.author}:{})};
 return JSON.stringify(reference).length<=8192?reference:null;
}
function atReference(value:unknown,view?:unknown):FeedReference|null {
 const item=row(value),id=item.uri;
 if(typeof id!=="string" || !id.isWellFormed())return null;
 const parts=/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/.exec(id);if(!parts)return null;
 return parseFeedReference({id,permalink:`https://bsky.app/profile/${encodeURIComponent(parts[1])}/post/${encodeURIComponent(parts[2])}`,author:row(row(view).author).handle});
}
function fields(replyTo:FeedReference|null,root:FeedReference|null){return {...(replyTo?{replyTo}:{}),...(root?{root}:{})};}
export function atprotoReply(value:unknown,view?:unknown){const reply=row(value),views=row(view);return fields(atReference(reply.parent,views.parent),atReference(reply.root,views.root));}
export function activityPubReply(value:unknown){
 const item=row(value);const reference=(value:unknown)=>{const id=typeof value==="string"?value:row(value).id;return parseFeedReference({id,permalink:id});};
 return fields(reference(item.inReplyTo),reference(item.context));
}
export function farcasterReply(value:unknown){
 const item=row(value),parent=row(item.parentCastId),hash=parent.hash??item.parentHash;
 if(typeof hash==="string" && /^(0x)?[a-f0-9]{40}$/i.test(hash)){
  const id=hash.startsWith("0x")?hash:`0x${hash}`;return fields(parseFeedReference({id,permalink:`https://farcaster.xyz/~/conversations/${id}`}),null);
 }
 return fields(parseFeedReference({id:item.parentUrl,permalink:item.parentUrl}),null);
}
export function nostrReply(value:unknown){
 const tags=(Array.isArray(value)?value.slice(0,128):[]).filter(tag=>Array.isArray(tag)&&tag[0]==="e"&&typeof tag[1]==="string"&&/^[a-f0-9]{64}$/i.test(tag[1]));
 const marked=tags.some(tag=>tag[3]==="root"||tag[3]==="reply");
 const roots=tags.filter(tag=>tag[3]==="root"),replies=tags.filter(tag=>tag[3]==="reply");
 const positional=tags.filter(tag=>!tag[3]);
 const reference=(tag:unknown[]|undefined)=>tag?parseFeedReference({id:String(tag[1]).toLowerCase(),permalink:`https://njump.me/${String(tag[1]).toLowerCase()}`}):null;
 return fields(reference(marked?replies.at(-1)??roots[0]:positional.at(-1)),reference(marked?roots[0]:positional[0]));
}
