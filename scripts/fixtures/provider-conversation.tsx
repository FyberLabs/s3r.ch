import React from "react";
import {createRoot} from "react-dom/client";
import FeedConversation from "../../components/FeedConversation";
import {threadAnchor,activityAnchor} from "./provider-thread-data";
createRoot(document.getElementById("root")!).render(<FeedConversation item={location.search.includes("activitypub")?activityAnchor:threadAnchor}/>);
