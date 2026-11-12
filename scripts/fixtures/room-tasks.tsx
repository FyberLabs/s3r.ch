// Loopback browser-test fixture. This entry is never included in the Next app.
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { RoomTasks } from "../../components/RoomTasks";
import { SeeAclProvider, useSeeAcl } from "../../components/SeeAclProvider";
import { identitySessionChanged } from "../../components/useIdentitySession";
import { applySeeGrant, roomSoul } from "../../lib/identity/check";
import { preparePublishRoomChat, type ChatMessage } from "../../lib/chat";
const owner = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const other = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const room = "s3rch:room:0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266:100:work";
function Fixture() {
  const see = useSeeAcl();
  const [shared, setShared] = useState(false), [ready, setReady] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>(() => JSON.parse(localStorage.getItem("fixture-work") ?? "[]"));
  const [, refresh] = useState(0);
  const [published, setPublished] = useState(0);
  useEffect(() => { if (see?.ready) { see.acl.putObject(roomSoul(room), owner); setReady(true); } }, [see]);
  return <><h1>Isolated room task fixture</h1>
    <button onClick={() => setShared(value => !value)}>Toggle shared room</button>
    <button onClick={async () => { await fetch("/fixture/other", { method: "POST" }); identitySessionChanged(); }}>Switch to reader without access</button>
    <button onClick={async () => { await fetch("/fixture/owner", { method: "POST" }); identitySessionChanged(); }}>Switch back to owner</button>
    <button onClick={() => { if (see) { applySeeGrant(see.acl, owner, { claimId: roomSoul(room), accessor: other, from: 0, until: Math.floor(Date.now() / 1000) + 300 }); refresh(value => value + 1); } }}>Grant other room access</button>
    <output aria-label="Published events">{published}</output>
    {ready && see ? <RoomTasks roomId={room} messages={messages} onPublicGraph={shared} onComposed={(message, put) => {
      if (put) {
        if ("denied" in preparePublishRoomChat(see.acl, message, owner, shared ? [room] : [])) throw Error("Fixture publication refused");
        setPublished(value => value + 1);
      }
      setMessages(held => { const next = [...held, message]; localStorage.setItem("fixture-work", JSON.stringify(next)); return next; });
    }} /> : null}</>;
}
createRoot(document.getElementById("root")!).render(<SeeAclProvider><Fixture /></SeeAclProvider>);
