// Isolated CI component contract: authority/session and persistence are substitutions.
// Signature composition, admission, task projection and publication are production code.
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { RoomTasks } from "../../components/RoomTasks";
import { initialize, admission, other, changeActor, grantOther } from "./room-task-authority";
import { publishCurrentRoomChat } from "../../lib/room-chat-publication";
import { encodeKey } from "../../lib/identity/check";
import type { ChatMessage } from "../../lib/chat";
const room="s3rch:room:fixture-work";
function Fixture(){
 const [shared,setShared]=useState(false),[ready,setReady]=useState(false),[messages,setMessages]=useState<ChatMessage[]>([]);
 const [overflow,setOverflow]=useState(false),[published,setPublished]=useState(0);
 useEffect(()=>{let active=true;void(async()=>{
   const rows=JSON.parse(localStorage.getItem("fixture-work")??"[]") as ChatMessage[];
   const admitted=await Promise.all(rows.map(row=>admission.receive(row,room,encodeKey(row.id))));
   if(active){setMessages(admitted.filter((row):row is NonNullable<typeof row>=>!!row));setReady(true);}
 })();return()=>{active=false;};},[]);
 return <><h1>Isolated signed room task fixture</h1>
  <output aria-label="Other identity">{other()}</output>
  <button onClick={()=>setShared(v=>!v)}>Toggle shared room</button>
  <button onClick={()=>changeActor(1)}>Switch to reader without access</button>
  <button onClick={()=>changeActor(0)}>Switch back to owner</button>
  <button onClick={grantOther}>Grant other room access</button>
  <button onClick={()=>setOverflow(true)}>Simulate full raw history</button>
  <output aria-label="Published events">{published}</output>
  {ready && <RoomTasks roomId={room} messages={messages} historySize={overflow?8193:messages.length} onPublicGraph={shared} onComposed={message=>{
    const next=[...messages,message];
    publishCurrentRoomChat({room,currentRows:()=>[message],taskHistory:()=>next,publicRoom:()=>shared,admission,publish:()=>setPublished(n=>n+1)});
    setMessages(next);localStorage.setItem("fixture-work",JSON.stringify(next));
  }}/>}</>;
}
void initialize().then(()=>createRoot(document.getElementById("root")!).render(<Fixture/>));
