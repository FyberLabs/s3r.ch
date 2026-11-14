import type {FeedItem} from "../../lib/feed-types";
const did="did:plc:"+"a".repeat(24);
export const threadUri=(id:string)=>`at://${did}/app.bsky.feed.post/${id}`;
const link=(id:string)=>`https://bsky.app/profile/fixture.test/post/${id}`;
export const threadAnchor:FeedItem={id:threadUri("child"),source:"atproto",kind:"social",author:"fixture.test",body:"Public child",ts:1,permalink:link("child"),tags:[],provenance:"fixture",replyTo:{id:threadUri("parent"),permalink:link("parent")}};
function view(id:string,text:string,parent?:string){return {$type:"app.bsky.feed.defs#threadViewPost",post:{uri:threadUri(id),author:{did,handle:"fixture.test"},record:{$type:"app.bsky.feed.post",text,createdAt:"2026-01-01T00:00:00Z",...(parent?{reply:{parent:{uri:threadUri(parent)},root:{uri:threadUri("root")}}}:{})}}};}
export const providerThread={thread:{...view("child","Public child","parent"),parent:{...view("parent","Provider parent","root"),post:{...view("parent","Provider parent","root").post,embed:{$type:"app.bsky.embed.images#view",images:[{fullsize:"https://example.com/parent.png",alt:"Parent photo"}]}},parent:view("root","Provider root")},replies:[view("reply","Provider reply","child")]}};
export const activityUri=(id:string)=>`https://example.com/posts/${id}`;
export const activityAnchor:FeedItem={...threadAnchor,id:activityUri("child"),source:"activitypub",permalink:activityUri("child"),replyTo:{id:activityUri("parent"),permalink:activityUri("parent")}};
const activity=(id:string,content:string,parent?:string)=>({id:activityUri(id),type:"Note",attributedTo:"https://example.com/users/fixture",to:["https://www.w3.org/ns/activitystreams#Public"],content,...(parent?{inReplyTo:activityUri(parent)}:{})});
export const activityObjects:Record<string,unknown>={
 [activityUri("child")]:{...activity("child","Public child","parent"),replies:{type:"Collection",items:[activityUri("reply")]}},
 [activityUri("parent")]:{...activity("parent","Provider parent","root"),attachment:[{type:"Image",mediaType:"image/png",url:"https://example.com/parent.png",name:"Parent photo"}]},
 [activityUri("root")]:activity("root","Provider root"),[activityUri("reply")]:activity("reply","Provider reply","child"),
};
export const farcasterHash=(n:number)=>"0x"+n.toString(16).padStart(40,"0");
export const farcasterAnchor:FeedItem={...threadAnchor,id:farcasterHash(3),source:"farcaster",permalink:`https://farcaster.xyz/~/conversations/${farcasterHash(3)}`,provenance:"farcaster:hub:https://hub.pinata.cloud/v1/castsByFid?fid=2&pageSize=20",replyTo:{id:farcasterHash(2),permalink:`https://farcaster.xyz/~/conversations/${farcasterHash(2)}`}};
const cast=(n:number,text:string,parent?:number)=>({hash:farcasterHash(n),data:{fid:2,type:"MESSAGE_TYPE_CAST_ADD",timestamp:123,castAddBody:{text,...(parent?{parentCastId:{fid:2,hash:farcasterHash(parent)}}:{})}}});
export const farcasterMessages=[cast(1,"Provider root"),{...cast(2,"Provider parent",1),data:{...cast(2,"Provider parent",1).data,castAddBody:{...cast(2,"Provider parent",1).data.castAddBody,embeds:[{url:"https://example.com/parent.png"}]}}},cast(3,"Public child",2),cast(4,"Provider reply",3)];
