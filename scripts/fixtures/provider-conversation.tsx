import React from "react";
import {createRoot} from "react-dom/client";
import FeedConversation from "../../components/FeedConversation";
import {threadAnchor,activityAnchor} from "./provider-thread-data";
const root=createRoot(document.getElementById("root")!);
if(location.search.includes("nostr")||location.search.includes("farcaster"))void fetch("/fixture-anchor").then(response=>response.json()).then(item=>root.render(<FeedConversation item={item}/>));
else root.render(<FeedConversation item={location.search.includes("activitypub")?activityAnchor:threadAnchor}/>);
