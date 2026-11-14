import type {FeedItem} from "../../lib/feed-types";
const did="did:plc:"+"a".repeat(24);
export const threadUri=(id:string)=>`at://${did}/app.bsky.feed.post/${id}`;
const link=(id:string)=>`https://bsky.app/profile/fixture.test/post/${id}`;
export const threadAnchor:FeedItem={id:threadUri("child"),source:"atproto",kind:"social",author:"fixture.test",body:"Public child",ts:1,permalink:link("child"),tags:[],provenance:"fixture",replyTo:{id:threadUri("parent"),permalink:link("parent")}};
function view(id:string,text:string,parent?:string){return {$type:"app.bsky.feed.defs#threadViewPost",post:{uri:threadUri(id),author:{did,handle:"fixture.test"},record:{$type:"app.bsky.feed.post",text,createdAt:"2026-01-01T00:00:00Z",...(parent?{reply:{parent:{uri:threadUri(parent)},root:{uri:threadUri("root")}}}:{})}}};}
export const providerThread={thread:{...view("child","Public child","parent"),parent:{...view("parent","Provider parent","root"),post:{...view("parent","Provider parent","root").post,embed:{$type:"app.bsky.embed.images#view",images:[{fullsize:"https://example.com/parent.png",alt:"Parent photo"}]}},parent:view("root","Provider root")},replies:[view("reply","Provider reply","child")]}};
