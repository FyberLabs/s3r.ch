'use client';
import {useRef,useState} from 'react';
import {encodeLedgerEntry,ledgerEntries,LEDGER_TEXT_MAX,type LedgerEntry} from '@/lib/forum-ledger';
import type {FeedItem} from '@/lib/feed-types';
import {btnPrimary,field} from '@/lib/brand-ui';

/** Receives only the live forum's authorized chat projection; no preview rows. */
export function ForumLedger({rows,send,writable}:{rows:readonly FeedItem[];writable:boolean;send(body:string):Promise<boolean>}) {
  const [text,setText]=useState(''),[owner,setOwner]=useState(''),[kind,setKind]=useState<LedgerEntry['kind']>('decision');
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  const pending=useRef(false);
  async function submit(){
    if(pending.current||!writable)return;pending.current=true;setBusy(true);setNotice('');
    try {
      const body=encodeLedgerEntry({kind,text:text.trim(),owner:owner.trim()||null});
      if(await send(body)){setText('');setOwner('');setNotice('Ledger entry sent. It appears after verification.');}
      else setNotice('Entry not sent. Check current forum access and retry.');
    }catch{setNotice('Use a short entry and a valid SEA account for the owner, or leave the owner empty.');}
    finally{pending.current=false;setBusy(false);}
  }
  const entries=ledgerEntries(rows);
  return <section aria-label="Business ledger" className="space-y-3 border border-rule bg-panel p-4">
    <h2 className="font-semibold">Business ledger</h2>
    <p className="text-sm text-ink-muted">Signed decisions and open work from this forum. Recorded owners do not gain permissions. This view shows the currently available verified history.</p>
    {!entries.length&&<p>No verified ledger entries available.</p>}
    <ol className="space-y-3">{entries.map(entry=><li key={entry.id} className="border-t border-rule pt-2">
      <strong>{entry.kind==='decision'?'Decision':'Open work'}</strong><p className="whitespace-pre-wrap break-words">{entry.text}</p>
      <p className="break-all text-xs">Author: {entry.author}</p>
      {entry.owner&&<p className="break-all text-xs">Recorded owner: {entry.owner}</p>}
    </li>)}</ol>
    <form className="space-y-2" onSubmit={event=>{event.preventDefault();void submit();}}>
      <label className="block">Entry type<select className={field} disabled={busy||!writable} value={kind} onChange={event=>setKind(event.target.value as LedgerEntry['kind'])}><option value="decision">Decision</option><option value="work">Open work</option></select></label>
      <label className="block">Entry<textarea className={`${field} w-full`} disabled={busy||!writable} value={text} maxLength={LEDGER_TEXT_MAX} onChange={event=>setText(event.target.value)}/></label>
      <label className="block">Owner SEA account (optional)<input className={`${field} w-full`} disabled={busy||!writable} value={owner} maxLength={87} autoComplete="off" spellCheck={false} onChange={event=>setOwner(event.target.value)}/></label>
      <button className={btnPrimary} disabled={busy||!writable||!text.trim()}>{busy?'Sending…':'Add signed entry'}</button>
    </form>
    {notice&&<p role="status">{notice}</p>}
  </section>;
}
