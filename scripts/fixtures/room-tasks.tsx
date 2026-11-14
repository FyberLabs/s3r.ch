// Loopback browser-test fixture. This entry is never included in the Next app.
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { RoomTasks } from "../../components/RoomTasks";
import { SeeAclProvider, useSeeAcl } from "../../components/SeeAclProvider";
import { identitySessionChanged } from "../../components/useIdentitySession";
import { applySeeGrant, roomSoul } from "../../lib/identity/check";
import { preparePublishRoomChat, type ChatMessage } from "../../lib/chat";
const owner = "axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";
const other = "fPJ7GI0DT36KUjgDBLUaw8CJaeJ38hs1pgtI_EdmmXg.B3dVENuO0EApPZrGn3Qw27p9reY86YIpngS3nSJ4c9E";
const room = "s3rch:room:axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU:100:work";
function Fixture() {
  const see = useSeeAcl();
  const [shared, setShared] = useState(false), [ready, setReady] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>(() => JSON.parse(localStorage.getItem("fixture-work") ?? "[]"));
  const [overflow, setOverflow] = useState(false);
  const [, refresh] = useState(0);
  const [published, setPublished] = useState(0);
  useEffect(() => { if (see?.ready) { see.acl.putObject(roomSoul(room), owner); setReady(true); } }, [see]);
  return <><h1>Isolated room task fixture</h1>
    <button onClick={() => setShared(value => !value)}>Toggle shared room</button>
    <button onClick={async () => { await fetch("/fixture/other", { method: "POST" }); identitySessionChanged(); }}>Switch to reader without access</button>
    <button onClick={async () => { await fetch("/fixture/owner", { method: "POST" }); identitySessionChanged(); }}>Switch back to owner</button>
    <button onClick={() => { if (see) { applySeeGrant(see.acl, owner, { claimId: roomSoul(room), accessor: other, from: 0, until: Math.floor(Date.now() / 1000) + 300 }); refresh(value => value + 1); } }}>Grant other room access</button>
    <button onClick={() => setOverflow(true)}>Simulate full raw history</button>
    <output aria-label="Published events">{published}</output>
    {ready && see ? <RoomTasks roomId={room} messages={messages} historySize={overflow ? 8193 : messages.length} onPublicGraph={shared} onComposed={(message, put) => {
      if (put) {
        if ("denied" in preparePublishRoomChat(see.acl, message, owner, shared ? [room] : [])) throw Error("Fixture publication refused");
        setPublished(value => value + 1);
      }
      setMessages(held => { const next = [...held, message]; localStorage.setItem("fixture-work", JSON.stringify(next)); return next; });
    }} /> : null}</>;
}
createRoot(document.getElementById("root")!).render(<SeeAclProvider><Fixture /></SeeAclProvider>);
