import {createItemStatusClient} from "./media-group-item-status-client";
import {parseItemStatusCommand} from "./media-group-item-status";
import {applyItemStatus,pendingItemStatus,discardItemStatus,type PendingItemStatus} from "./media-group-item-status-recovery";
import {createItemWrapClient,type ItemWrapTarget} from "./media-group-item-wrap-client";
import {applyItemWrap,pendingItemWrap,type PendingItemWrap} from "./media-group-item-wrap-recovery";
import {applyEpochDelivery,pendingEpochDelivery,discardEpochDelivery} from "./media-group-item-epoch-delivery";
import {parseGroupCommand} from "./media-group-command";
import type {PendingItemEpoch} from "./media-group-item-epoch-recovery";
import {createItemGrantClient} from "./media-group-item-grant-client";
import {parseItemGrantCommand} from "./media-group-item-grant";
import {applyItemGrant,pendingItemGrant,discardItemGrant,type PendingItemGrant} from "./media-group-item-grant-recovery";
import {createGroupKeyClient} from "./media-group-key-client";
import {applyGroupKey,pendingGroupKey,deliverGroupKey,finishGroupKeyDelivery,discardGroupKey,type PendingGroupKey} from "./media-group-key-recovery";
import {applyGroupCommand as applyDurableGroupCommand,pendingGroupCommand,discardGroupCommand,type PendingGroupCommand} from "./media-group-command-recovery";
import {createGroupCommandClient,parseSignedGroupCommand,type GroupSignedCommand} from "./media-group-client";
import {applyGroupConsent,pendingGroupConsent,discardGroupConsent,type PendingGroupConsent} from "./media-group-recovery";
import {createMediaGroupMember} from "./media-group-member";
import {parseMediaGroupScope,type MediaGroupScope} from "./media-group";
import { createShareJournal } from "./media-share-journal";
import { shareMedia, pendingMediaShare, abandonMediaShare, type PendingShare } from "./media-share-recovery";
import { readGrantedMedia } from "./media-reader-catalog";
import { parseMediaDeletionIntent, type MediaDeletionIntent } from "./media-deletion";
import { createUploadJournal } from "./media-upload-journal";
import { uploadMedia, pendingMediaUpload, discardMediaUpload } from "./media-upload";
import type { MediaFileDescription } from "./media-file";
import type { UnverifiedObjectRecord } from "./identity/forum-object-record";
import { createPrivateMediaOwner } from "./media-owner-client";
import { createPrivateMediaReader } from "./media-wrap-client";
import { readSingleUnlockedIdentity, subscribeUnlockedMeshPair } from "./identity/unlocked-mesh";
import type { SeaPair } from "./identity/sea";
import type { ItemReaderWrap } from "sociacl-ids";
import type { MediaCiphertextReference } from "./media-client";

/** Browser memory only. A held SEA key is possession, never an object grant.
 * sessionKey must come from the current authenticated SEA session. */
export function createPrivateMediaBrowser(sessionKey: () => string | null, fetcher: typeof fetch = fetch) {
  async function run<T>(operation: (pair: SeaPair, fetcher: typeof fetch, signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal, discard?: (result: T) => void): Promise<T> {
    const selected=readSingleUnlockedIdentity();
    if(!selected || selected.pair.pub!==sessionKey())throw Error("Unlock the signed-in media identity");
    const stopped=new AbortController();
    const deadline=AbortSignal.any([stopped.signal,...(signal?[signal]:[]),AbortSignal.timeout(120000)]);
    const check=()=>{
      const current=readSingleUnlockedIdentity();
      if(!current || current.revision!==selected.revision || current.pair.pub!==selected.pair.pub ||
          sessionKey()!==selected.pair.pub)stopped.abort();
      deadline.throwIfAborted();
    };
    // Listeners must not throw into the shared identity event dispatcher.
    const unsubscribe=subscribeUnlockedMeshPair(()=>{stopped.abort();});
    const guardedFetch: typeof fetch=async(url,init)=>{
      check();
      const response=await fetcher(url,{...init,signal:AbortSignal.any([deadline,...(init?.signal?[init.signal]:[])])});
      try {check();return response;}
      catch(error){await response.body?.cancel().catch(()=>{});throw error;}
    };
    try {
      check();const result=await operation(selected.pair,guardedFetch,deadline);
      try {check();return result;}catch(error){discard?.(result);throw error;}
    } finally {unsubscribe();stopped.abort();}
  }
  async function signed<T>(operation: (client: ReturnType<typeof createPrivateMediaOwner>, scalar: Uint8Array, signal: AbortSignal, transport: typeof fetch)=>Promise<T>,signal?:AbortSignal) {
    return run(async(pair,transport,deadline)=>{
      if(!/^[A-Za-z0-9_-]{43}$/.test(pair.priv))throw Error("Invalid media signing key");
      const scalar=Uint8Array.from(atob(pair.priv.replace(/-/g,"+").replace(/_/g,"/")+"="),c=>c.charCodeAt(0));
      try {
        if(scalar.length!==32 || btoa(String.fromCharCode(...scalar)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"")!==pair.priv)
          throw Error("Invalid media signing key");
        return await operation(createPrivateMediaOwner(transport),scalar,deadline,transport);
      } finally {scalar.fill(0);}
    },signal);
  }
  async function locked<T>(work:()=>Promise<T>,name="s3rch-private-upload-v1") {
    if (typeof navigator === "undefined" || !navigator.locks) throw Error("This browser cannot safely resume uploads");
    return navigator.locks.request(name, {mode:"exclusive",ifAvailable:true}, lock=>{
      if(!lock)throw Error("An upload is active in another tab");return work();
    });
  }
  async function epochWork(tenant:string,principal:string,change:{target?:{object:string;predicate:MediaGroupScope["predicate"];set:string};expected?:PendingItemEpoch},signal?:AbortSignal){
    return locked(()=>run(async(pair,transport,deadline)=>{
      if(!/^[A-Za-z0-9_-]{43}$/.test(pair.priv))throw Error("Invalid media signing key");
      const scalar=Uint8Array.from(atob(pair.priv.replace(/-/g,"+").replace(/_/g,"/")+"="),c=>c.charCodeAt(0));
      try{
        if(scalar.length!==32||btoa(String.fromCharCode(...scalar)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"")!==pair.priv)throw Error("Invalid media signing key");
        return await applyEpochDelivery({tenant,principal,pair,scalar,fetcher:transport,signal:deadline,
          journal:createShareJournal(undefined,"group-item-epoch-delivery"),...change});
      }finally{scalar.fill(0);}
    },signal),"s3rch-private-group-item-epoch-delivery-v1");
  }
  return Object.freeze({
    startItemWrap(tenant:string,principal:string,target:ItemWrapTarget,signal?:AbortSignal){
      const held=parseGroupCommand("item-wrap-view",target,principal) as ItemWrapTarget;
      return locked(()=>run(async(pair,transport,deadline)=>{
        const input={tenant,principal,pair,fetcher:transport,signal:deadline,journal:createShareJournal(undefined,"group-item-wrap")};
        if(await pendingItemWrap(input))throw Error("A group item key delivery requires recovery");
        const bundle=await createItemWrapClient(principal,transport).prepare(held,pair,deadline);
        return await applyItemWrap({...input,bundle});
      },signal),"s3rch-private-group-item-wrap-v1");
    },
    pendingItemWrap(tenant:string,principal:string,signal?:AbortSignal){
      return run((pair,transport,deadline)=>pendingItemWrap({tenant,principal,pair,fetcher:transport,signal:deadline,
        journal:createShareJournal(undefined,"group-item-wrap")}),signal);
    },
    resumeItemWrap(tenant:string,principal:string,expected:PendingItemWrap,signal?:AbortSignal){
      const held=structuredClone(expected);
      return locked(()=>run((pair,transport,deadline)=>applyItemWrap({tenant,principal,pair,fetcher:transport,signal:deadline,
        journal:createShareJournal(undefined,"group-item-wrap"),expected:held}),signal),"s3rch-private-group-item-wrap-v1");
    },
    startItemEpoch(tenant:string,principal:string,target:{object:string;predicate:"same-group"|"named-circle";set:string},signal?:AbortSignal){
      const held=parseGroupCommand("item-epoch-view",target,principal) as typeof target;
      return epochWork(tenant,principal,{target:held},signal);
    },
    pendingItemEpoch(tenant:string,principal:string,signal?:AbortSignal){
      return run((pair,transport,deadline)=>pendingEpochDelivery({tenant,principal,pair,fetcher:transport,signal:deadline,
        journal:createShareJournal(undefined,"group-item-epoch-delivery")}),signal);
    },
    resumeItemEpoch(tenant:string,principal:string,expected:PendingItemEpoch,signal?:AbortSignal){
      return epochWork(tenant,principal,{expected:structuredClone(expected)},signal);
    },
    discardItemEpoch(tenant:string,principal:string,expected:PendingItemEpoch,signal?:AbortSignal){
      const held=structuredClone(expected);
      return locked(()=>run((pair,transport,deadline)=>discardEpochDelivery({tenant,principal,pair,fetcher:transport,signal:deadline,
        journal:createShareJournal(undefined,"group-item-epoch-delivery"),expected:held}),signal),"s3rch-private-group-item-epoch-delivery-v1");
    },
    startItemStatus(tenant:string,principal:string,target:{object:string;predicate:"same-group"|"named-circle";set:string;reader:string},signal?:AbortSignal){
      const held=parseItemStatusCommand("item-status-view",target,principal);
      return locked(()=>run(async(pair,transport,deadline)=>{
        const input={tenant,principal,pair,fetcher:transport,signal:deadline,journal:createShareJournal(undefined,"group-item-status")};
        if(await pendingItemStatus(input))throw Error("A group item request requires recovery");
        if(!/^[A-Za-z0-9_-]{43}$/.test(pair.priv))throw Error("Invalid media signing key");
        const scalar=Uint8Array.from(atob(pair.priv.replace(/-/g,"+").replace(/_/g,"/")+"="),c=>c.charCodeAt(0));
        try{
          if(scalar.length!==32||btoa(String.fromCharCode(...scalar)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"")!==pair.priv)throw Error("Invalid media signing key");
          const command=await createItemStatusClient(principal,transport).prepare(held,scalar,deadline);
          return await applyItemStatus({...input,command});
        }finally{scalar.fill(0);}
      },signal),"s3rch-private-group-item-status-v1");
    },
    pendingItemStatus(tenant:string,principal:string,signal?:AbortSignal){
      return run((pair,transport,deadline)=>pendingItemStatus({tenant,principal,pair,fetcher:transport,signal:deadline,
        journal:createShareJournal(undefined,"group-item-status")}),signal);
    },
    resumeItemStatus(tenant:string,principal:string,expected:PendingItemStatus,signal?:AbortSignal){
      const held=structuredClone(expected);
      return locked(()=>run((pair,transport,deadline)=>applyItemStatus({tenant,principal,pair,fetcher:transport,signal:deadline,
        journal:createShareJournal(undefined,"group-item-status"),expected:held}),signal),"s3rch-private-group-item-status-v1");
    },
    discardItemStatus(tenant:string,principal:string,expected:PendingItemStatus,signal?:AbortSignal){
      const held=structuredClone(expected);
      return locked(()=>run((pair,transport,deadline)=>discardItemStatus({tenant,principal,pair,fetcher:transport,signal:deadline,
        journal:createShareJournal(undefined,"group-item-status"),expected:held}),signal),"s3rch-private-group-item-status-v1");
    },
    startItemGrant(tenant:string,principal:string,target:{object:string;predicate:"same-group"|"named-circle";set:string;reader:string;withdraw:boolean},signal?:AbortSignal){
      const held=parseItemGrantCommand("item-grant-view",target,principal);
      return locked(()=>run(async(pair,transport,deadline)=>{
        const input={tenant,principal,pair,fetcher:transport,signal:deadline,journal:createShareJournal(undefined,"group-item-grant")};
        if(await pendingItemGrant(input))throw Error("A group item request requires recovery");
        if(!/^[A-Za-z0-9_-]{43}$/.test(pair.priv))throw Error("Invalid media signing key");
        const scalar=Uint8Array.from(atob(pair.priv.replace(/-/g,"+").replace(/_/g,"/")+"="),c=>c.charCodeAt(0));
        try{
          if(scalar.length!==32||btoa(String.fromCharCode(...scalar)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"")!==pair.priv)throw Error("Invalid media signing key");
          const command=await createItemGrantClient(principal,transport).prepare(held,scalar,deadline);
          return await applyItemGrant({...input,command});
        }finally{scalar.fill(0);}
      },signal),"s3rch-private-group-item-grant-v1");
    },
    pendingItemGrant(tenant:string,principal:string,signal?:AbortSignal){
      return run((pair,transport,deadline)=>pendingItemGrant({tenant,principal,pair,fetcher:transport,signal:deadline,
        journal:createShareJournal(undefined,"group-item-grant")}),signal);
    },
    resumeItemGrant(tenant:string,principal:string,expected:PendingItemGrant,signal?:AbortSignal){
      const held=structuredClone(expected);
      return locked(()=>run((pair,transport,deadline)=>applyItemGrant({tenant,principal,pair,fetcher:transport,signal:deadline,
        journal:createShareJournal(undefined,"group-item-grant"),expected:held}),signal),"s3rch-private-group-item-grant-v1");
    },
    discardItemGrant(tenant:string,principal:string,expected:PendingItemGrant,signal?:AbortSignal){
      const held=structuredClone(expected);
      return locked(()=>run((pair,transport,deadline)=>discardItemGrant({tenant,principal,pair,fetcher:transport,signal:deadline,
        journal:createShareJournal(undefined,"group-item-grant"),expected:held}),signal),"s3rch-private-group-item-grant-v1");
    },
    startGroupKey(tenant:string,principal:string,scope:MediaGroupScope,signal?:AbortSignal){
      const held=parseMediaGroupScope(scope);
      return locked(()=>run(async(pair,transport,deadline)=>{
        const input={tenant,principal,pair,fetcher:transport,signal:deadline,journal:createShareJournal(undefined,"group-key")};
        if(await pendingGroupKey(input))throw Error("A group key requires recovery");
        const client=createGroupKeyClient(principal,transport);
        await client.allocate(held,deadline);
        if(!/^[A-Za-z0-9_-]{43}$/.test(pair.priv))throw Error("Invalid group signing key");
        const scalar=Uint8Array.from(atob(pair.priv.replace(/-/g,"+").replace(/_/g,"/")+"="),c=>c.charCodeAt(0));
        const secret=crypto.getRandomValues(new Uint8Array(32));
        try{
          if(scalar.length!==32||btoa(String.fromCharCode(...scalar)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"")!==pair.priv)throw Error("Invalid group signing key");
          const command=await client.prepare(held,crypto.randomUUID(),secret,scalar,deadline);
          return await applyGroupKey({...input,command,groupKey:secret});
        }finally{scalar.fill(0);secret.fill(0);}
      },signal),"s3rch-private-group-key-v1");
    },
    pendingGroupKey(tenant:string,principal:string,signal?:AbortSignal){
      return run((pair,transport,deadline)=>pendingGroupKey({tenant,principal,pair,fetcher:transport,signal:deadline,
        journal:createShareJournal(undefined,"group-key")}),signal);
    },
    resumeGroupKey(tenant:string,principal:string,expected:PendingGroupKey,signal?:AbortSignal){
      const held=structuredClone(expected);
      return locked(()=>run((pair,transport,deadline)=>{
        const input={tenant,principal,pair,fetcher:transport,signal:deadline,journal:createShareJournal(undefined,"group-key"),expected:held};
        return held.phase==="prepared"?applyGroupKey(input):deliverGroupKey(input);
      },signal),"s3rch-private-group-key-v1");
    },
    finishGroupKey(tenant:string,principal:string,expected:PendingGroupKey,signal?:AbortSignal){
      const held=structuredClone(expected);
      return locked(()=>run((pair,transport,deadline)=>finishGroupKeyDelivery({tenant,principal,pair,fetcher:transport,signal:deadline,
        journal:createShareJournal(undefined,"group-key"),expected:held}),signal),"s3rch-private-group-key-v1");
    },
    discardGroupKey(tenant:string,principal:string,expected:PendingGroupKey,signal?:AbortSignal){
      const held=structuredClone(expected);
      return locked(()=>run((pair,transport,deadline)=>discardGroupKey({tenant,principal,pair,fetcher:transport,signal:deadline,
        journal:createShareJournal(undefined,"group-key"),expected:held}),signal),"s3rch-private-group-key-v1");
    },
    groupCatalog(principal:string,page=0,signal?:AbortSignal){
      return run((_pair,transport,deadline)=>createGroupCommandClient(principal,transport).catalog(page,deadline),signal);
    },
    runGroupCommand(tenant:string,principal:string,command:GroupSignedCommand,signal?:AbortSignal){
      const held=parseSignedGroupCommand(command,principal);
      return locked(()=>run((pair,transport,deadline)=>applyDurableGroupCommand({tenant,principal,pair,fetcher:transport,signal:deadline,
        journal:createShareJournal(undefined,"group-command"),command:held}),signal),"s3rch-private-group-command-v1");
    },
    resumeGroupCommand(tenant:string,principal:string,expected:PendingGroupCommand,signal?:AbortSignal){
      const held=structuredClone(expected);
      return locked(()=>run((pair,transport,deadline)=>applyDurableGroupCommand({tenant,principal,pair,fetcher:transport,signal:deadline,
        journal:createShareJournal(undefined,"group-command"),expected:held}),signal),"s3rch-private-group-command-v1");
    },
    pendingGroupCommand(tenant:string,principal:string,signal?:AbortSignal){
      return run((pair,transport,deadline)=>pendingGroupCommand({tenant,principal,pair,fetcher:transport,signal:deadline,
        journal:createShareJournal(undefined,"group-command")}),signal);
    },
    discardGroupCommand(tenant:string,principal:string,expected:PendingGroupCommand,signal?:AbortSignal){
      const held=structuredClone(expected);
      return locked(()=>run((pair,transport,deadline)=>discardGroupCommand({tenant,principal,pair,fetcher:transport,signal:deadline,
        journal:createShareJournal(undefined,"group-command"),expected:held}),signal),"s3rch-private-group-command-v1");
    },
    prepareGroupCreation(principal:string,object:string,scope:MediaGroupScope,windowMs:number,signal?:AbortSignal){
      const held=parseMediaGroupScope(scope);
      return signed((_owner,key,deadline,transport)=>createGroupCommandClient(principal,transport).prepareCreate(object,held,windowMs,key,deadline),signal);
    },
    prepareGroupMembership(principal:string,scope:MediaGroupScope,member:string,role:"member"|"set",stated:0|1,signal?:AbortSignal){
      const held=parseMediaGroupScope(scope);
      return signed((_owner,key,deadline,transport)=>createGroupCommandClient(principal,transport).prepareMember(held,member,role,stated,key,deadline),signal);
    },
    groupCommandState(principal:string,command:GroupSignedCommand,signal?:AbortSignal){
      const held=parseSignedGroupCommand(command,principal);
      return run((_pair,transport,deadline)=>createGroupCommandClient(principal,transport).state(held,deadline),signal);
    },
    applyGroupCommand(principal:string,command:GroupSignedCommand,signal?:AbortSignal){
      const held=parseSignedGroupCommand(command,principal);
      return run((_pair,transport,deadline)=>createGroupCommandClient(principal,transport).apply(held,deadline),signal);
    },
    consent(tenant:string,target:{object:string;scope:MediaGroupScope;member:string;stated:0|1},signal?:AbortSignal){
      const held=structuredClone(target);
      return locked(()=>run((pair,transport,deadline)=>applyGroupConsent({tenant,pair,fetcher:transport,signal:deadline,journal:createShareJournal(undefined,"group-consent"),target:held}),signal),"s3rch-private-group-consent-v1");
    },
    resumeConsent(tenant:string,expected:PendingGroupConsent,signal?:AbortSignal){
      const held=structuredClone(expected);
      return locked(()=>run((pair,transport,deadline)=>applyGroupConsent({tenant,pair,fetcher:transport,signal:deadline,journal:createShareJournal(undefined,"group-consent"),expected:held}),signal),"s3rch-private-group-consent-v1");
    },
    pendingConsent(tenant:string,signal?:AbortSignal){
      return run((pair,_transport,deadline)=>pendingGroupConsent(createShareJournal(undefined,"group-consent"),tenant,pair,deadline),signal);
    },
    discardConsent(tenant:string,expected:PendingGroupConsent,signal?:AbortSignal){
      const held=structuredClone(expected);
      return locked(()=>run((pair,transport,deadline)=>discardGroupConsent({tenant,pair,fetcher:transport,signal:deadline,journal:createShareJournal(undefined,"group-consent"),expected:held}),signal),"s3rch-private-group-consent-v1");
    },
    prepareGroupConsent(object:string,scope:MediaGroupScope,member:string,stated:0|1,signal?:AbortSignal){
      const held=parseMediaGroupScope(scope);
      return signed((_owner,key,deadline,transport)=>createMediaGroupMember(transport).prepare(object,held,member,stated,key,deadline),signal);
    },
    groupConsentState(object:string,scope:MediaGroupScope,member:string,row:unknown,signal?:AbortSignal){
      const held=parseMediaGroupScope(scope),input=structuredClone(row);
      return run((_pair,transport,deadline)=>createMediaGroupMember(transport).state(object,held,member,input,deadline),signal);
    },
    appendGroupConsent(object:string,scope:MediaGroupScope,member:string,row:unknown,signal?:AbortSignal){
      const held=parseMediaGroupScope(scope),input=structuredClone(row);
      return run((_pair,transport,deadline)=>createMediaGroupMember(transport).append(object,held,member,input,deadline),signal);
    },
    share(tenant:string,target:{object:string;owner:string;reader:string;remove?:boolean},signal?:AbortSignal){
      return locked(()=>run((pair,transport,deadline)=>shareMedia({tenant,pair,fetcher:transport,signal:deadline,journal:createShareJournal(),target}),signal),"s3rch-private-share-v1");
    },
    resumeShare(tenant:string,expected:PendingShare,signal?:AbortSignal){
      const held={...expected};
      return locked(()=>run((pair,transport,deadline)=>shareMedia({tenant,pair,fetcher:transport,signal:deadline,journal:createShareJournal(),expected:held}),signal),"s3rch-private-share-v1");
    },
    abandonShare(tenant:string,expected:PendingShare,signal?:AbortSignal){
      const held={...expected};
      return locked(()=>run((pair,_transport,deadline)=>abandonMediaShare(createShareJournal(),tenant,held,pair,deadline),signal),"s3rch-private-share-v1");
    },
    pendingShare(tenant:string,signal?:AbortSignal){
      return run((pair,_transport,deadline)=>pendingMediaShare(createShareJournal(),tenant,pair,deadline),signal);
    },
    upload(tenant:string,file?:{bytes:Uint8Array;description:MediaFileDescription},signal?:AbortSignal,progress?:(message:string)=>void,allocationConfirmed?:()=>void){
      return locked(()=>run((pair,transport,deadline)=>uploadMedia({tenant,pair,fetcher:transport,signal:deadline,journal:createUploadJournal(),file,progress,allocationConfirmed}),signal));
    },
    pendingUpload(tenant:string,signal?:AbortSignal){
      return run((pair,_transport,deadline)=>pendingMediaUpload(createUploadJournal(),tenant,pair,deadline),signal);
    },
    discardUpload(tenant:string,expectedObject:string,signal?:AbortSignal){
      return locked(()=>run((pair,_transport,deadline)=>discardMediaUpload(createUploadJournal(),tenant,expectedObject,pair,deadline),signal));
    },
    allocate(record:UnverifiedObjectRecord,signal?:AbortSignal){
      return run((_pair,transport,deadline)=>createPrivateMediaOwner(transport).allocate(record,deadline),signal);
    },
    catalog(page:number,signal?:AbortSignal){
      return run((_pair,transport,deadline)=>createPrivateMediaOwner(transport).catalog(page,deadline),signal);
    },
    grantedCatalog(page:number,signal?:AbortSignal){
      return run((_pair,transport,deadline)=>readGrantedMedia(page,transport,deadline),signal);
    },
    recipients(object:string,owner:string,signal?:AbortSignal){
      return run((_pair,transport,deadline)=>createPrivateMediaOwner(transport).recipients(object,owner,deadline),signal);
    },
    prepareDeletion(tenant:string,object:string,owner:string,signal?:AbortSignal){
      return signed((client,key,deadline)=>client.prepareDeletion(tenant,object,owner,key,deadline),signal);
    },
    submitDeletion(input:MediaDeletionIntent,signal?:AbortSignal){
      const intent=parseMediaDeletionIntent(input);
      return run((pair,transport,deadline)=>{
        if(pair.pub!==intent.ownerPub)throw Error("Deletion signing identity changed");
        return createPrivateMediaOwner(transport).submitDeletion(intent,deadline);
      },signal);
    },
    cleanupCatalog(page:number,signal?:AbortSignal){
      return run((_pair,transport,deadline)=>createPrivateMediaOwner(transport).cleanupCatalog(page,deadline),signal);
    },
    cleanup(object:string,command:string,signal?:AbortSignal){
      return run((_pair,transport,deadline)=>createPrivateMediaOwner(transport).cleanup(object,command,deadline),signal);
    },
    cancel(object:string,reader:string,signal?:AbortSignal){
      return signed((client,key,deadline)=>client.cancel(object,reader,key,deadline),signal);
    },
    grant(object:string,owner:string,draft:unknown,signal?:AbortSignal){
      return signed((client,key,deadline)=>client.grant(object,owner,draft,key,deadline),signal);
    },
    prepareShare(object:string,owner:string,reader:string,signal?:AbortSignal){
      return signed((client,key,deadline)=>client.prepareShare(object,owner,reader,key,deadline),signal);
    },
    prepareNextEpoch(object:string,owner:string,draft:unknown,signal?:AbortSignal){
      return signed((client,key,deadline)=>client.prepareNextEpoch(object,owner,draft,key,deadline),signal);
    },
    initialEpoch(object:string,owner:string,draft:unknown,signal?:AbortSignal){
      return signed((client,key,deadline)=>client.initialEpoch(object,owner,draft,key,deadline),signal);
    },
    epoch(object:string,owner:string,draft:unknown,finalization:unknown,signal?:AbortSignal){
      return signed((client,key,deadline)=>client.epoch(object,owner,draft,finalization,key,deadline),signal);
    },
    status(object:string,reader:string,signal?:AbortSignal){
      return signed((client,key,deadline)=>client.status(object,reader,key,deadline),signal);
    },
    publishWrap(object:string,owner:string,reader:string,wrap:ItemReaderWrap,reference:MediaCiphertextReference,signal?:AbortSignal){
      return run((_pair,transport,deadline)=>createPrivateMediaOwner(transport).publishWrap(object,owner,reader,wrap,reference,deadline),signal);
    },
    open(object:string,tenant:string,signal?:AbortSignal){
      return run((pair,transport,deadline)=>createPrivateMediaReader(transport).open(object,tenant,pair.epriv,pair.epub,deadline),signal,
        result=>result.bytes.fill(0));
    },
  });
}
