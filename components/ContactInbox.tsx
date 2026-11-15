"use client";

import { useEffect, useRef, useState } from "react";
import { contactText, type ContactInboxSession, type ContactInboxView, type ContactMessageView } from "@/lib/contact-inbox-view";

/** Mount only with the authenticated contacts adapter. A held key or a transport
 * URL alone cannot supply a session. No raw key or plaintext is persisted here. */
export function ContactInbox({ session }: { session: ContactInboxSession | null }) {
  return session ? <SessionInbox key={session.id} session={session} /> : <p>Contacts are unavailable for this session.</p>;
}
function SessionInbox({ session }: { session: ContactInboxSession }) {
  const [view,setView]=useState<ContactInboxView|null>(null),[peer,setPeer]=useState("");
  const [messages,setMessages]=useState<readonly ContactMessageView[]>([]),[draft,setDraft]=useState("");
  const [busy,setBusy]=useState(false),[status,setStatus]=useState("");
  const [locked,setLocked]=useState(!session.current());
  const operation=useRef<AbortController|null>(null),mounted=useRef(true);
  const pending=useRef<{peer:string;submit:(signal:AbortSignal)=>Promise<void>}|null>(null);
  function valid(signal:AbortSignal){signal.throwIfAborted();if(!mounted.current||!session.current())throw Error('Session changed');}
  function clear(){operation.current?.abort();setView(null);setMessages([]);setDraft("");setPeer("");pending.current=null;setBusy(false);}
  async function run(action:(signal:AbortSignal)=>Promise<void>){
    if(operation.current)return;
    const controller=new AbortController();operation.current=controller;setBusy(true);setStatus("");
    const timeout=setTimeout(()=>{if(operation.current===controller){controller.abort();operation.current=null;if(mounted.current){setBusy(false);setStatus("This action timed out. Retry when your contact session is available.");}}},15000);
    try{valid(controller.signal);await action(controller.signal);valid(controller.signal);}
    catch{if(mounted.current&&!controller.signal.aborted)setStatus("Could not complete this action. Retry when your contact session is available.");}
    finally{clearTimeout(timeout);if(operation.current===controller){operation.current=null;if(mounted.current)setBusy(false);}}
  }
  async function load(signal:AbortSignal){const next=await session.load(signal);valid(signal);setView(next);}
  useEffect(()=>{
    mounted.current=true;
    const off=session.subscribe(()=>{
      clear();operation.current=null;setLocked(!session.current());
      if(session.current())void run(load);
    });
    if(session.current())void run(load);
    return()=>{mounted.current=false;off();operation.current?.abort();operation.current=null;pending.current=null;};
    // A new session id remounts this component and clears all private UI state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[session]);
  async function select(principal:string){
    if(busy||operation.current)return;setPeer(principal);setMessages([]);setDraft("");pending.current=null;
    await run(async signal=>{const rows=await session.messages(principal,signal);valid(signal);setMessages(rows);});
  }
  async function decide(id:string,accept:boolean){await run(async signal=>{
    if(accept)await session.accept(id,signal);else await session.reject(id,signal);
    valid(signal);await load(signal);
  });}
  async function block(principal:string){await run(async signal=>{
    await session.block(principal,signal);valid(signal);
    pending.current=null;setMessages([]);setDraft("");setPeer("");await load(signal);
  });}
  async function send(){await run(async signal=>{
    const selected=view?.contacts.find(contact=>contact.principal===peer);
    if(!selected||selected.blocked)throw Error('Contact unavailable');
    if(!pending.current){const prepared=await session.prepareMessage(peer,contactText(draft),signal);valid(signal);pending.current={peer,submit:prepared.submit.bind(prepared)};}
    const held=pending.current;if(held.peer!==peer)throw Error('Contact changed');
    await held.submit(signal);valid(signal);pending.current=null;setDraft("");
    const rows=await session.messages(peer,signal);valid(signal);setMessages(rows);
  });}
  if(locked||!session.current())return <p role="status">Unlock your contact session to continue.</p>;
  const selected=view?.contacts.find(contact=>contact.principal===peer);
  return <section aria-label="Contacts" className="space-y-4">
    <h2 className="font-semibold">Contacts</h2>
    {status&&<p role="status">{status}</p>}
    {!view?<p>{busy?"Loading contacts…":"Contacts could not be loaded."}</p>:<>
      <section aria-label="Contact requests"><h3>Requests</h3>
        {!view.requests.length&&<p>No pending requests.</p>}
        {view.requests.map(request=><article key={request.id} className="border rounded p-3">
          <p className="break-all">{request.sender}</p><p className="whitespace-pre-wrap">{request.message}</p>
          <button disabled={busy} onClick={()=>void decide(request.id,true)}>Accept</button>{" "}
          <button disabled={busy} onClick={()=>void decide(request.id,false)}>Decline</button>
        </article>)}
      </section>
      <section aria-label="Accepted contacts"><h3>Your contacts</h3>
        {!view.contacts.length&&<p>No contacts yet.</p>}
        {view.contacts.map(contact=><div key={contact.principal} className="flex flex-wrap gap-2">
          <button className="break-all" disabled={busy||contact.blocked} onClick={()=>void select(contact.principal)}>{contact.principal}</button>
          {contact.blocked?<span>Blocked</span>:<button disabled={busy} onClick={()=>void block(contact.principal)}>Block</button>}
        </div>)}
      </section>
      {selected&&!selected.blocked&&<section aria-label="Contact conversation">
        <h3 className="break-all">Messages with {peer}</h3>
        <ol>{messages.map(message=><li key={message.id}><span className="break-all">{message.sender}</span><p className="whitespace-pre-wrap">{message.body}</p></li>)}</ol>
        <form onSubmit={event=>{event.preventDefault();void send();}}>
          <label>Message<textarea value={draft} disabled={busy||!!pending.current} onChange={event=>setDraft(event.target.value)} maxLength={1024}/></label>
          <button disabled={busy||(!draft.trim()&&!pending.current)}>{pending.current?"Retry message":"Send message"}</button>
        </form>
      </section>}
    </>}
    <button disabled={busy} onClick={()=>void run(load)}>Refresh contacts</button>
  </section>;
}
