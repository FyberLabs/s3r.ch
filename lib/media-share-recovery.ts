import type { SeaPair } from "./identity/sea";
import { createPrivateMediaOwner, PrivateMediaConflict } from "./media-owner-client";
import { createPrivateMediaReader } from "./media-wrap-client";
import { parseMediaSharePlan } from "./media-share";
import { decryptShareJournal, encryptShareJournal, shareDigest, type ShareJournal, type ShareEntry } from "./media-share-journal";

export type PendingShare=Readonly<{object:string;reader:string;token:string}>;
type SignedPlan=Awaited<ReturnType<ReturnType<typeof createPrivateMediaOwner>["prepareShare"]>>;
type Prepared=Awaited<ReturnType<ReturnType<typeof createPrivateMediaReader>["prepareSharing"]>>;
type Draft={version:1;tenant:string;object:string;owner:string;reader:string;plan:ReturnType<typeof parseMediaSharePlan>;grants:SignedPlan["grants"];prepared:Prepared};
function parse(value:unknown,entry:ShareEntry,tenant:string,pair:SeaPair):Draft {
  if(!value||typeof value!=="object"||Array.isArray(value))throw Error("Invalid sharing recovery");
  const d=value as Draft;
  if(d.version!==1||d.tenant!==tenant||d.object!==entry.object||!Array.isArray(d.grants)||!d.prepared)throw Error("Invalid sharing recovery");
  const plan=parseMediaSharePlan(d.plan,d.object,d.owner,d.reader);
  if(plan.ownerPub!==pair.pub||plan.bindings[d.owner].epub!==pair.epub||d.grants.length!==plan.grants.length||
      d.grants.some((g,i)=>JSON.stringify(g.claims)!==JSON.stringify(plan.grants[i])))throw Error("Sharing identity or grants changed");
  const p=d.prepared,m=p.document?.manifest;
  if(!m||m.object!==d.object||m.epoch!==plan.previousEpoch+1||p.finalization?.revisionId!==m.revisionId||
      p.finalization.previousFinalizationId!==plan.previousFinalizationId||JSON.stringify(p.document.snapshot)!==JSON.stringify(plan.snapshot)||
      !p.reference||p.reference.sha256!==plan.grants[0].itemCiphertextDigest||!Number.isSafeInteger(p.reference.length)||
      !Array.isArray(p.wraps)||p.wraps.length!==plan.grants.length||plan.grants.some(g=>!p.wraps.some(w=>w.object===d.object&&
        w.epoch===m.epoch&&w.revisionId===m.revisionId&&w.targetId===plan.bindings[g.accessor].epub)))throw Error("Sharing recovery changed");
  return d;
}
export async function pendingMediaShare(journal:ShareJournal,tenant:string,pair:SeaPair,signal:AbortSignal) {
  const entry=await journal.read(signal);signal.throwIfAborted();if(!entry)return null;
  const draft=parse(await decryptShareJournal(entry,tenant,pair),entry,tenant,pair);
  signal.throwIfAborted();return {object:draft.object,reader:draft.reader,token:entry.sha256};
}
export async function abandonMediaShare(journal:ShareJournal,tenant:string,expected:PendingShare,pair:SeaPair,signal:AbortSignal) {
  const entry=await journal.read(signal);signal.throwIfAborted();if(!entry)return;
  const draft=parse(await decryptShareJournal(entry,tenant,pair),entry,tenant,pair);
  if(expected.object!==draft.object||expected.reader!==draft.reader||expected.token!==entry.sha256)throw Error("Saved sharing changed; inspect it again");
  signal.throwIfAborted();await journal.remove(entry.revision,signal);
}
/** Save all signatures and opaque wraps before publishing; resume never re-signs them. */
export async function shareMedia(input:{tenant:string;pair:SeaPair;fetcher:typeof fetch;signal:AbortSignal;journal:ShareJournal;
  target?:{object:string;owner:string;reader:string};expected?:PendingShare}) {
  const {tenant,pair,fetcher,signal,journal}=input,client=createPrivateMediaOwner(fetcher);
  let entry=await journal.read(signal),draft:Draft;
  if(!/^[A-Za-z0-9_-]{43}$/.test(pair.priv))throw Error("Invalid signing key");
  const scalar=Uint8Array.from(atob(pair.priv.replace(/-/g,"+").replace(/_/g,"/")+"="),c=>c.charCodeAt(0));
  try {
    if(entry) {
      if(input.target)throw Error("Resume the existing sharing change first");
      draft=parse(await decryptShareJournal(entry,tenant,pair),entry,tenant,pair);
      if(!input.expected||input.expected.object!==draft.object||input.expected.reader!==draft.reader||input.expected.token!==entry.sha256)
        throw Error("Saved sharing changed; inspect it before resuming");
    } else {
      if(!input.target)throw Error("No pending sharing change");
      const {object,owner,reader}=input.target;
      // Refresh only the owner's existing delivery status; no new access yet.
      await client.status(object,owner,scalar,signal);
      const signed=await client.prepareShare(object,owner,reader,scalar,signal);
      const plan=parseMediaSharePlan({...signed,grants:signed.grants.map(g=>g.claims)},object,owner,reader);
      const prepared=await createPrivateMediaReader(fetcher).prepareSharing(object,tenant,pair.epriv,pair.epub,plan,owner,reader,scalar,signal);
      draft={version:1,tenant,object,owner,reader,plan,grants:signed.grants,prepared};
      const encrypted=await encryptShareJournal(draft,tenant,object,pair);signal.throwIfAborted();
      entry=await journal.write({...encrypted,tenant,object},null,signal);
      draft=parse(draft,entry,tenant,pair);
    }
    const d=draft;
    async function apply(operation:"grant"|"epoch",payload:unknown) {
      const state=await client.shareState(d.object,operation,payload,signal);
      if(state==="conflict")throw new PrivateMediaConflict();
      if(state==="absent")await client.commitUploadIntent(d.object,d.owner,operation,payload,signal);
    }
    for(const grant of d.grants)await apply("grant",grant);
    await apply("epoch",{document:d.prepared.document,finalization:d.prepared.finalization});
    let pending=false;
    for(const grant of d.plan.grants) {
      const wrap=d.prepared.wraps.find(w=>w.targetId===d.plan.bindings[grant.accessor].epub)!;
      const record=await shareDigest(new TextEncoder().encode(JSON.stringify({wrap,reference:d.prepared.reference})));
      const metadata={reader:grant.accessor,record,digest:record,epoch:wrap.epoch,revisionId:wrap.revisionId,
        readerEpub:wrap.targetId,itemDigest:d.prepared.reference.sha256};
      const state=await client.shareState(d.object,"wrap",metadata,signal);
      if(state==="conflict")throw new PrivateMediaConflict();
      try {
        if(state==="absent")await client.publishWrap(d.object,d.owner,grant.accessor,wrap,d.prepared.reference,signal);

      } catch(error) {
        signal.throwIfAborted();if(error instanceof PrivateMediaConflict)throw error;
        // A future grant or unsettled epoch can defer this recipient. Keep the
        // exact recovery record; do not report delivery or manufacture time.
        pending=true;
      }
    }
    // Wrap publication changes the object version; only sign statuses after
    // every possible wrap has been reconciled in this attempt.
    for(const grant of d.plan.grants) {
      try {await client.status(d.object,grant.accessor,scalar,signal);}
      catch(error) {signal.throwIfAborted();if(error instanceof PrivateMediaConflict)throw error;pending=true;}
    }
    signal.throwIfAborted();
    if(!pending)await journal.remove(entry.revision,signal);
    return {object:d.object,reader:d.reader,token:entry.sha256,pending};
  } finally {scalar.fill(0);}
}
