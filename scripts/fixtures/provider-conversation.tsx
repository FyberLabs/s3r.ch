import React from "react";
import {createRoot} from "react-dom/client";
import FeedConversation from "../../components/FeedConversation";
import {threadAnchor} from "./provider-thread-data";
createRoot(document.getElementById("root")!).render(<FeedConversation item={threadAnchor}/>);
