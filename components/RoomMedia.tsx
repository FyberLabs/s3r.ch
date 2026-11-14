"use client";

import { useRef, useState } from "react";
import type { ChatMessage } from "@/lib/chat";
import { composeCurrentRoomMedia } from "@/lib/room-media-composition";
import { useRoomAuthority } from "./RoomAuthorityProvider";
import { useIdentitySession } from "./useIdentitySession";
import { useMediaTenant } from "./useMediaTenant";
import { RoomMediaPanel, type PanelProps } from "./RoomMediaPanel";
import { btnSecondary } from "@/lib/brand-ui";

export function RoomMedia({roomId,messages,onPublicGraph,onComposed}: {
  roomId:string;messages:readonly ChatMessage[];onPublicGraph:boolean;
  onComposed:(message:ChatMessage,putOnGun:boolean)=>void;
}) {
  const session=useIdentitySession();
  const {current:authority}=useRoomAuthority();
  const [expanded,setExpanded]=useState(false);
  const current=useRef({authority,owner:session?.owner,roomId});
  current.current={authority,owner:session?.owner,roomId};
  return <section className="mt-4 space-y-3" aria-label="Room private media">
    <button type="button" className={btnSecondary} onClick={()=>setExpanded(value=>!value)}>{expanded?"Close room media":"Open room media"}</button>
    {expanded && <ConfiguredRoomMedia key={roomId+":"+(session?.owner??"")} roomId={roomId} messages={messages}
      canRead={message=>!!authority?.admission.valid(message)}
      send={async (body,stillCurrent)=>{
        if(!authority || !session)return false;
        const next=await composeCurrentRoomMedia({room:roomId,body,admission:authority.admission,pair:authority.pair,
          current:()=>stillCurrent() && current.current.authority===authority && current.current.owner===session.owner && current.current.roomId===roomId});
        if(!next)return false;
        onComposed(next,onPublicGraph);return true;
      }}/>}</section>;
}


function ConfiguredRoomMedia(props:PanelProps) {
  const tenant=useMediaTenant();
  if(tenant===undefined)return <p role="status">Loading private media availability…</p>;
  if(!tenant)return <p>Private media is not available on this site yet.</p>;
  return <RoomMediaPanel key={tenant} {...props} tenant={tenant}/>;
}

