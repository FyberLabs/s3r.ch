import type {PendingItemWrap} from "./media-group-item-wrap-recovery";
import type {PendingItemStatus} from "./media-group-item-status-recovery";
import type {PendingItemEpoch} from "./media-group-item-epoch-recovery";
import type {PendingItemGrant} from "./media-group-item-grant-recovery";
import type {PendingGroupKey} from "./media-group-key-recovery";
import { mintObjectId, parsePrincipalId } from "sociacl-ids";
import type { GroupCatalogEntry } from "./media-group-command";
import type { PendingGroupCommand } from "./media-group-command-recovery";
import type { PendingGroupConsent } from "./media-group-recovery";
import { isCanonicalObjectId } from "./identity/object-id";
import type { MediaCleanupItem } from "./media-catalog";
import type { MediaDeletionIntent } from "./media-deletion";
import { readMemePngTags } from "./meme-png-tags";
import { mediaPreviewKind } from "./media-preview";
import { createPrivateMediaBrowser } from "./media-browser-session";
import { readBoundedIdentityJson } from "./identity/bounded-json";
import { isSeaPubkey } from "./identity/forum-check";
import { subscribeUnlockedMeshPair } from "./identity/unlocked-mesh";

class SessionUnavailable extends Error {}

export type MediaLibraryState = Readonly<{ busy: boolean; objects: readonly string[]; page: number;
  nextPage: number | null; loaded: boolean; message: string;
  consent: PendingGroupConsent | null;
  groupCommand: PendingGroupCommand | null;
  groupKey: PendingGroupKey | null;
  itemGrant: PendingItemGrant | null;
  itemEpoch: PendingItemEpoch | null;
  itemWrap: PendingItemWrap | null;
  itemStatus: PendingItemStatus | null;
  groups: Readonly<{entries:readonly GroupCatalogEntry[];page:number;nextPage:number|null}> | null;
  sharing: Readonly<{object:string;reader:string;token:string;remove?:boolean}> | null;
  granted: Readonly<{objects:readonly string[];page:number;nextPage:number|null}> | null;
  cleanup: Readonly<{objects:readonly MediaCleanupItem[];page:number;nextPage:number|null}> | null;
  deletion: Readonly<{object:string;prepared:boolean}> | null;
  audience: Readonly<{object:string;readers:readonly string[]}> | null;
  preview: Readonly<{ url: string; name: string; mediaType: string; tags?:readonly string[] }> | null }>;
const empty = (): MediaLibraryState => ({busy:false,objects:[],page:0,nextPage:null,loaded:false,message:"",preview:null,audience:null,deletion:null,cleanup:null,granted:null,sharing:null,consent:null,groupCommand:null,groupKey:null,itemGrant:null,itemEpoch:null,itemWrap:null,itemStatus:null,groups:null});

/** Private, in-memory navigation. Never persists catalog entries or plaintext. */
export function createMediaLibrary(changed: (state: MediaLibraryState)=>void, options: {
  fetcher?: typeof fetch; clock?: ()=>number;
  browser?: typeof createPrivateMediaBrowser;
  makeUrl?: (blob: Blob)=>string; revokeUrl?: (url: string)=>void;
} = {}) {
  const fetcher=options.fetcher ?? fetch, clock=options.clock ?? Date.now;
  const makeUrl=options.makeUrl ?? URL.createObjectURL, revokeUrl=options.revokeUrl ?? URL.revokeObjectURL;
  let state=empty(), key: string|null=null, owner: string|null=null, expires=0, generation=0, disposed=false;
  let deletionIntent: MediaDeletionIntent|null=null;
  let pending: AbortController|null=null, expiry: ReturnType<typeof setTimeout>|undefined;
  const browser=(options.browser ?? createPrivateMediaBrowser)(()=>clock()<expires ? key : null,fetcher);
  function publish(next: MediaLibraryState) { state=Object.freeze(next); if(!disposed)changed(state); }
  function clearPreview() { if(state.preview)revokeUrl(state.preview.url); }
  function reset(message="") {
    generation++;deletionIntent=null;pending?.abort();pending=null;key=null;owner=null;expires=0;
    if(expiry)clearTimeout(expiry);expiry=undefined;clearPreview();publish({...empty(),message});
  }
  const unsubscribe=subscribeUnlockedMeshPair(()=>reset("Identity changed. Refresh your media."));
  async function session(signal: AbortSignal) {
    let response:Response;
    try {response=await fetcher("/api/identity/sea/session",{credentials:"same-origin",cache:"no-store",redirect:"error",signal});}
    catch {throw new SessionUnavailable();}
    if(response.status>=500 || response.status===429) {
      await response.body?.cancel().catch(()=>{});throw new SessionUnavailable();
    }
    if(!response.ok || response.headers.get("content-type")?.split(";")[0]!=="application/json") {
      await response.body?.cancel().catch(()=>{});throw Error("Sign in with your saved identity to view media.");
    }
    let value:Record<string,unknown>|null;
    try {value=await readBoundedIdentityJson(response,4096,signal) as Record<string,unknown>|null;}
    catch {throw new SessionUnavailable();}
    signal.throwIfAborted();
    if(!value || value.enabled!==true || typeof value.principal!=="string" || !isSeaPubkey(value.principal) ||
        !Number.isSafeInteger(value.expiresAt) || (value.expiresAt as number)<=clock() ||
        (value.expiresAt as number)>clock()+300000)throw Error("Sign in with your saved identity to view media.");
    if(key && key!==value.principal)throw Error("Identity changed");
    key=value.principal;expires=value.expiresAt as number;
    if(expiry)clearTimeout(expiry);
    expiry=setTimeout(()=>reset("Your identity session expired. Sign in and refresh your media."),Math.max(0,expires-clock()));
  }
  async function operation(work: (signal: AbortSignal, current: ()=>boolean)=>Promise<void>, failed?: ()=>void) {
    if(disposed || state.busy)return;
    const attempt=++generation, controller=new AbortController();pending=controller;
    const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(120000)]);
    const current=()=>!disposed && attempt===generation && !signal.aborted && clock()<expires;
    clearPreview();publish({...state,busy:true,message:"",preview:null});
    let started=false;
    try {
      await session(signal);
      if(!current())return;
      started=true;await work(signal,current);
    } catch(error) {
      if(!disposed && attempt===generation) {
        if((started || (error instanceof SessionUnavailable && deletionIntent)) && current() && failed)failed();
        else reset("Media is unavailable. Check your identity session and access, then retry.");
      }
    } finally {
      if(!disposed && attempt===generation){pending=null;publish({...state,busy:false});}
    }
  }
  function openAuthorized(object: string, tenant: string) {
      return operation(async(signal,current)=>{
        if(state.objects.includes(object)) {
          if (!owner) throw Error("Media owner unavailable");
          await browser.status(object,owner,signal);
        }
        const file=await browser.open(object,tenant,signal);
        try {
          if(!current())return;
          if(!mediaPreviewKind(file.description.mediaType)) {
            publish({...state,message:"This file format cannot be previewed."});return;
          }
          const url=makeUrl(new Blob([new Uint8Array(file.bytes)],{type:file.description.mediaType}));
          if(!current()){revokeUrl(url);return;}
          publish({...state,preview:{url,...file.description,...(file.description.mediaType==="image/png"?{tags:readMemePngTags(file.bytes)}:{})}});
        } finally {file.bytes.fill(0);}
      });
  }
  return Object.freeze({
    reset,
    requestDeletion(object:string) {
      if(disposed || state.busy || state.deletion || !owner || !state.objects.includes(object))return;
      clearPreview();deletionIntent=null;
      publish({...state,preview:null,audience:null,message:"",deletion:{object,prepared:false}});
    },
    cancelDeletion() {
      if(disposed || state.busy)return;
      deletionIntent=null;publish({...state,deletion:null,message:""});
    },
    confirmDeletion(tenant:string) {
      const selected=state.deletion, principal=owner;
      if(!selected || !principal)return Promise.resolve();
      return operation(async(signal,current)=>{
        if(!deletionIntent) {
          const intent=await browser.prepareDeletion(tenant,selected.object,principal,signal);
          if(!current())return;
          deletionIntent=intent;publish({...state,deletion:{object:selected.object,prepared:true}});
        }
        await browser.submitDeletion(deletionIntent,signal);
        if(current()) {
          deletionIntent=null;
          publish({...state,objects:state.objects.filter(object=>object!==selected.object),deletion:null,audience:null,
            message:"Deletion accepted. Access stopped; storage cleanup is pending."});
        }
      },()=>publish({...state,message:deletionIntent
        ? "Deletion could not be confirmed. Retry sends the same request. Closing does not undo an accepted deletion."
        : "Deletion could not be prepared. Check your access and retry."}));
    },
    loadCleanup(page=0) {
      if(state.deletion)return Promise.resolve();
      return operation(async(signal,current)=>{
        const catalog=await browser.cleanupCatalog(page,signal);
        if(current())publish({...state,cleanup:{objects:catalog.objects,page,nextPage:catalog.nextPage},audience:null});
      });
    },
    cleanup(object:string,command:string) {
      if(state.deletion || !state.cleanup?.objects.some(item=>item.object===object && item.command===command))return Promise.resolve();
      return operation(async(signal,current)=>{
        await browser.cleanup(object,command,signal);
        if(current() && state.cleanup)publish({...state,cleanup:{...state.cleanup,
          objects:state.cleanup.objects.filter(item=>item.object!==object)},message:"Storage cleanup confirmed."});
      },()=>publish({...state,message:"Storage cleanup could not be confirmed. Refresh pending cleanup or retry."}));
    },
    load(page=0) {
      if(state.deletion)return Promise.resolve();
      return operation(async(signal,current)=>{
        const catalog=await browser.catalog(page,signal);
        if(current()){owner=catalog.principal;publish({...state,objects:catalog.objects,page,nextPage:catalog.nextPage,loaded:true,audience:null});}
      });
    },
    loadGranted(page=0) {
      if(state.deletion)return Promise.resolve();
      return operation(async(signal,current)=>{
        const catalog=await browser.grantedCatalog(page,signal);
        if(current())publish({...state,granted:{objects:catalog.objects,page,nextPage:catalog.nextPage},audience:null});
      });
    },
    startItemWrap(tenant:string,object:string,predicate:"same-group"|"named-circle",set:string,reader:string) {
      if(state.deletion||state.itemGrant||state.itemEpoch||state.itemWrap||state.itemStatus||!owner||state.audience?.object!==object||!state.objects.includes(object)||!isSeaPubkey(reader)||!set)return Promise.resolve();
      const principal=owner;
      return operation(async(signal,current)=>{
        await browser.startItemWrap(tenant,principal,{object,predicate,set,reader},signal);
        if(current())publish({...state,itemWrap:null,message:"The group file key was delivered. Refresh this member’s access before they open it."});
      },()=>publish({...state,message:"The key delivery could not be confirmed. Check its saved request before trying again."}));
    },
    inspectItemWrap(tenant:string) {
      if(state.deletion||!owner)return Promise.resolve();const principal=owner;
      return operation(async(signal,current)=>{
        const itemWrap=await browser.pendingItemWrap(tenant,principal,signal);
        if(current())publish({...state,itemWrap,message:itemWrap?"A key delivery request is saved. Retry to confirm it.":"No saved key delivery request."});
      });
    },
    resumeItemWrap(tenant:string) {
      if(state.deletion||!state.itemWrap||!owner)return Promise.resolve();const principal=owner,selected={...state.itemWrap};
      return operation(async(signal,current)=>{
        await browser.resumeItemWrap(tenant,principal,selected,signal);
        if(current())publish({...state,itemWrap:null,message:"The group file key was delivered. Refresh this member’s access before they open it."});
      },()=>publish({...state,message:"The saved key delivery request is retained. Check access and retry recovery."}));
    },
    startItemStatus(tenant:string,object:string,predicate:"same-group"|"named-circle",set:string,reader:string) {
      if(state.deletion||state.itemGrant||state.itemEpoch||state.itemWrap||state.itemStatus||!owner||state.audience?.object!==object||!state.objects.includes(object)||!isSeaPubkey(reader)||!set)return Promise.resolve();
      const principal=owner;
      return operation(async(signal,current)=>{
        await browser.startItemStatus(tenant,principal,{object,predicate,set,reader},signal);
        if(current())publish({...state,itemStatus:null,message:"This member’s current file access was confirmed. It expires shortly; refresh it when needed."});
      },()=>publish({...state,message:"The member access could not be confirmed. Check its saved request before trying again."}));
    },
    inspectItemStatus(tenant:string) {
      if(state.deletion||!owner)return Promise.resolve();const principal=owner;
      return operation(async(signal,current)=>{
        const itemStatus=await browser.pendingItemStatus(tenant,principal,signal);
        if(current())publish({...state,itemStatus,message:itemStatus?"A member access request is saved. Retry to confirm it.":"No saved member access request."});
      });
    },
    resumeItemStatus(tenant:string) {
      if(state.deletion||!state.itemStatus||!owner)return Promise.resolve();const principal=owner,selected={...state.itemStatus};
      return operation(async(signal,current)=>{
        await browser.resumeItemStatus(tenant,principal,selected,signal);
        if(current())publish({...state,itemStatus:null,message:"The saved member access request was reconciled. Refresh member file access again before opening; the original authorization may have expired."});
      },()=>publish({...state,message:"The saved member access request is retained. Check access and retry recovery."}));
    },
    discardItemStatus(tenant:string) {
      if(state.deletion||!state.itemStatus||!owner)return Promise.resolve();const principal=owner,selected={...state.itemStatus};
      return operation(async(signal,current)=>{
        await browser.discardItemStatus(tenant,principal,selected,signal);
        if(current())publish({...state,itemStatus:null,message:"The local member access request was cleared. Accepted changes were not undone."});
      },()=>publish({...state,message:"The saved member access request cannot be cleared yet. Retry recovery."}));
    },
    startItemEpoch(tenant:string,object:string,predicate:"same-group"|"named-circle",set:string) {
      if(state.deletion||state.itemGrant||state.itemEpoch||state.itemWrap||!owner||state.audience?.object!==object||!state.objects.includes(object)||!set)return Promise.resolve();
      const principal=owner;
      return operation(async(signal,current)=>{
        const result=await browser.startItemEpoch(tenant,principal,{object,predicate,set},signal);
        if(current())publish({...state,itemEpoch:null,message:result.pending?"Group access update accepted. Replacement keys remain saved until the waiting period and direct delivery complete. Check its saved request.":"Group access update accepted and direct access restored. Group key delivery still needs to finish."});
      },()=>publish({...state,itemEpoch:null,message:"The group access update could not be confirmed. Check its saved request before trying again."}));
    },
    inspectItemEpoch(tenant:string) {
      if(state.deletion||!owner)return Promise.resolve();const principal=owner;
      return operation(async(signal,current)=>{
        const itemEpoch=await browser.pendingItemEpoch(tenant,principal,signal);
        if(current())publish({...state,itemEpoch,message:itemEpoch?"A group access update is saved. Retry to confirm it.":"No saved group access update."});
      });
    },
    resumeItemEpoch(tenant:string) {
      if(state.deletion||!state.itemEpoch||!owner)return Promise.resolve();const selected={...state.itemEpoch},principal=owner;
      return operation(async(signal,current)=>{
        const result=await browser.resumeItemEpoch(tenant,principal,selected,signal);
        if(current())publish({...state,itemEpoch:null,message:result.pending?"Replacement keys remain saved. Retry after the waiting period to finish direct delivery.":"Group access update confirmed and direct access restored. Group key delivery still needs to finish."});
      },()=>publish({...state,message:"The saved group access update is retained. Check access and retry recovery."}));
    },
    discardItemEpoch(tenant:string) {
      if(state.deletion||!state.itemEpoch||!owner)return Promise.resolve();const selected={...state.itemEpoch},principal=owner;
      return operation(async(signal,current)=>{
        await browser.discardItemEpoch(tenant,principal,selected,signal);
        if(current())publish({...state,itemEpoch:null,message:"The unapplied local group access update was cleared."});
      },()=>publish({...state,message:"The saved access update cannot be cleared. Retry recovery; accepted updates need their replacement keys."}));
    },
    startItemGrant(tenant:string,object:string,predicate:"same-group"|"named-circle",set:string,reader:string,withdraw:boolean) {
      if(state.deletion||state.itemGrant||state.itemEpoch||state.itemWrap||!owner||state.audience?.object!==object||!state.objects.includes(object)||!isSeaPubkey(reader)||!set)return Promise.resolve();
      const principal=owner;
      return operation(async(signal,current)=>{
        const result=await browser.startItemGrant(tenant,principal,{object,predicate,set,reader,withdraw},signal);
        if(current())publish({...state,itemGrant:null,message:result.frozen?
          "The request is recorded, but this group grant is frozen. File access is unavailable through it.":
          withdraw?"Group permission withdrawn. Separately shared access is unchanged.":
          "Group permission recorded. File delivery still needs its access update and key delivery."});
      },()=>publish({...state,itemGrant:null,message:"The group permission could not be confirmed. Check its saved request before trying again."}));
    },
    inspectItemGrant(tenant:string) {
      if(state.deletion||!owner)return Promise.resolve();const principal=owner;
      return operation(async(signal,current)=>{
        const itemGrant=await browser.pendingItemGrant(tenant,principal,signal);
        if(current())publish({...state,itemGrant,message:itemGrant?"A group permission request is saved. Retry to confirm it.":"No saved group permission request."});
      });
    },
    resumeItemGrant(tenant:string) {
      if(state.deletion||!state.itemGrant||!owner)return Promise.resolve();const selected={...state.itemGrant},principal=owner;
      return operation(async(signal,current)=>{
        const result=await browser.resumeItemGrant(tenant,principal,selected,signal);
        if(current())publish({...state,itemGrant:null,message:result.frozen?
          "The request is recorded, but this group grant is frozen.":
          selected.withdraw?"Group permission withdrawal confirmed. Separately shared access is unchanged.":
          "Group permission recorded. File delivery still needs its access update and key delivery."});
      },()=>publish({...state,message:"The saved group permission request is retained. Check access and retry recovery."}));
    },
    discardItemGrant(tenant:string) {
      if(state.deletion||!state.itemGrant||!owner)return Promise.resolve();const selected={...state.itemGrant},principal=owner;
      return operation(async(signal,current)=>{
        await browser.discardItemGrant(tenant,principal,selected,signal);
        if(current())publish({...state,itemGrant:null,message:"The local group permission request was cleared. Accepted changes were not undone."});
      },()=>publish({...state,message:"The saved request cannot be cleared yet. Retry recovery; it may still apply."}));
    },
    startGroupKey(tenant:string,set:string,predicate:"same-group"|"named-circle") {
      const entry=state.groups?.entries.find(row=>row.set===set&&row.predicate===predicate);
      if(state.deletion||state.groupCommand||state.groupKey||!owner||!entry?.owned||!entry.active)return Promise.resolve();
      const principal=owner;
      return operation(async(signal,current)=>{
        const groupKey=await browser.startGroupKey(tenant,principal,{set,predicate},signal);
        if(current())publish({...state,groupKey,message:"The group key is saved. Continue to deliver it to current members."});
      },()=>publish({...state,groupKey:null,message:"The key change could not be confirmed. Check saved group keys before trying again."}));
    },
    inspectGroupKey(tenant:string) {
      if(state.deletion||!owner)return Promise.resolve();const principal=owner;
      return operation(async(signal,current)=>{
        const groupKey=await browser.pendingGroupKey(tenant,principal,signal);
        if(current())publish({...state,groupKey,message:groupKey?"A group key is saved. Continue its delivery.":"No saved group key."});
      });
    },
    resumeGroupKey(tenant:string) {
      if(state.deletion||!state.groupKey||!owner)return Promise.resolve();
      const selected=structuredClone(state.groupKey),principal=owner;
      return operation(async(signal,current)=>{
        const groupKey=await browser.resumeGroupKey(tenant,principal,selected,signal);
        if(current())publish({...state,groupKey,message:groupKey.total>0&&groupKey.published===groupKey.total?
          "All member keys were delivered. Verify your access after the group's waiting period before clearing this saved key.":"The group key is saved. Continue delivery."});
      },()=>publish({...state,groupKey:null,message:"Delivery could not be confirmed. Your encrypted key and exact pending wraps remain saved. Check saved group keys to continue."}));
    },
    finishGroupKey(tenant:string) {
      if(state.deletion||!state.groupKey||!owner)return Promise.resolve();const selected=structuredClone(state.groupKey),principal=owner;
      return operation(async(signal,current)=>{
        await browser.finishGroupKey(tenant,principal,selected,signal);
        if(current())publish({...state,groupKey:null,message:"Your durable group key was verified. The temporary recovery copy was cleared."});
      },()=>publish({...state,message:"Your current group key could not be opened yet. The saved key is retained; check membership and the group's waiting period."}));
    },
    discardGroupKey(tenant:string) {
      if(state.deletion||!state.groupKey||state.groupKey.phase!=="prepared"||!owner)return Promise.resolve();
      const selected=structuredClone(state.groupKey),principal=owner;
      return operation(async(signal,current)=>{
        await browser.discardGroupKey(tenant,principal,selected,signal);
        if(current())publish({...state,groupKey:null,message:"The unaccepted key change was cleared."});
      },()=>publish({...state,message:"This saved key cannot be cleared yet. Continue recovery or wait for outstanding requests to expire."}));
    },
    createGroup(tenant:string) {
      if(state.deletion||state.groupCommand||!owner||!state.objects.length)return Promise.resolve();
      const principal=owner,object=state.objects[0];
      return operation(async(signal,current)=>{
        if(await browser.pendingGroupCommand(tenant,principal,signal))throw Error("Saved group request requires recovery");
        const parsed=parsePrincipalId(principal);if(!parsed.ok)throw Error("Group owner unavailable");
        const minted=mintObjectId("set",parsed.value);if(!minted.ok)throw Error("Group identifier unavailable");
        const command=await browser.prepareGroupCreation(principal,object,{predicate:"same-group",set:minted.value},86400000,signal);
        await browser.runGroupCommand(tenant,principal,command,signal);
        if(current())publish({...state,groups:null,message:"Your empty group was created. Refresh groups to invite members. No files have been shared."});
      },()=>publish({...state,groups:null,groupCommand:null,message:"Group creation could not be confirmed. Check the saved group change before trying again."}));
    },
    inviteToGroup(tenant:string,set:string,predicate:"same-group"|"named-circle",member:string,stated:0|1) {
      const entry=state.groups?.entries.find(row=>row.set===set&&row.predicate===predicate);
      if(state.deletion||state.groupCommand||!owner||!entry?.owned||!isSeaPubkey(member))return Promise.resolve();
      const principal=owner;
      return operation(async(signal,current)=>{
        if(await browser.pendingGroupCommand(tenant,principal,signal))throw Error("Saved group request requires recovery");
        const command=await browser.prepareGroupMembership(principal,{set,predicate},member,"set",stated,signal);
        await browser.runGroupCommand(tenant,principal,command,signal);
        if(current())publish({...state,groups:null,message:stated===1?
          "The invitation was accepted by the service. The member must also consent before joining.":
          "Your invitation withdrawal was accepted. Refresh groups to see current state."});
      },()=>publish({...state,groups:null,groupCommand:null,message:"The invitation change could not be confirmed. Check the saved group change before trying again."}));
    },
    loadGroups(page=0) {
      if(state.deletion||!owner)return Promise.resolve();
      const principal=owner;
      return operation(async(signal,current)=>{
        const catalog=await browser.groupCatalog(principal,page,signal);
        if(current())publish({...state,groups:{entries:catalog.groups,page,nextPage:catalog.nextPage}});
      });
    },
    respondToGroup(tenant:string,set:string,predicate:"same-group"|"named-circle",stated:0|1) {
      const entry=state.groups?.entries.find(row=>row.set===set&&row.predicate===predicate);
      if(state.deletion||state.groupCommand||!owner||!entry||(stated===1?!entry.invited||entry.active:!entry.active))return Promise.resolve();
      const principal=owner;
      return operation(async(signal,current)=>{
        if(await browser.pendingGroupCommand(tenant,principal,signal))throw Error("Saved group request requires recovery");
        const command=await browser.prepareGroupMembership(principal,{set,predicate},principal,"member",stated,signal);
        await browser.runGroupCommand(tenant,principal,command,signal);
        if(current())publish({...state,groups:null,message:stated===1?
          "Your group response was accepted. Refresh groups; media access is checked separately.":
          "Your group withdrawal was accepted. Refresh groups to see current membership."});
      },()=>publish({...state,groups:null,groupCommand:null,message:"The group response could not be confirmed. Check the saved group change before trying again."}));
    },
    inspectGroupCommand(tenant:string) {
      if(state.deletion||!owner)return Promise.resolve();
      const principal=owner;
      return operation(async(signal,current)=>{
        const groupCommand=await browser.pendingGroupCommand(tenant,principal,signal);
        if(current())publish({...state,groupCommand,message:groupCommand?"A group change is saved. Retry to confirm it.":"No saved group change."});
      });
    },
    resumeGroupCommand(tenant:string) {
      if(state.deletion||!state.groupCommand||!owner)return Promise.resolve();
      const selected=structuredClone(state.groupCommand),principal=owner;
      return operation(async(signal,current)=>{
        await browser.resumeGroupCommand(tenant,principal,selected,signal);
        if(current())publish({...state,groupCommand:null,message:"The group change was accepted. Media access is checked separately."});
      },()=>publish({...state,groupCommand:null,message:"The group change could not be confirmed. Its saved request is retained. Check the saved group change again before retrying."}));
    },
    discardGroupCommand(tenant:string) {
      if(state.deletion||!state.groupCommand||!owner)return Promise.resolve();
      const selected=structuredClone(state.groupCommand),principal=owner;
      return operation(async(signal,current)=>{
        const result=await browser.discardGroupCommand(tenant,principal,selected,signal);
        if(current())publish({...state,groupCommand:null,message:result.applied?
          "The group change was already accepted. Its local saved copy was cleared.":
          "The unconfirmed group request was cleared. Accepted group changes are not undone."});
      },()=>publish({...state,message:"The saved group change cannot be cleared yet. Retry recovery; it may still apply or the source may be unavailable."}));
    },
    inspectConsent(tenant:string) {
      if(state.deletion)return Promise.resolve();
      return operation(async(signal,current)=>{
        const consent=await browser.pendingConsent(tenant,signal);
        if(current())publish({...state,consent,message:consent?"A group response is saved. Retry to confirm it.":"No saved group response."});
      });
    },
    resumeConsent(tenant:string) {
      if(state.deletion||!state.consent)return Promise.resolve();
      const selected=structuredClone(state.consent);
      return operation(async(signal,current)=>{
        await browser.resumeConsent(tenant,selected,signal);
        if(current())publish({...state,consent:null,message:"Your group response was accepted. Media access is checked separately."});
      },()=>publish({...state,message:"The group response could not be confirmed. Its saved request is retained."}));
    },
    discardConsent(tenant:string) {
      if(state.deletion||!state.consent)return Promise.resolve();
      const selected=structuredClone(state.consent);
      return operation(async(signal,current)=>{
        const result=await browser.discardConsent(tenant,selected,signal);
        if(current())publish({...state,consent:null,message:result?.applied?
          "The group response was already accepted. Its local saved copy was cleared.":
          "The saved request was cleared. This does not undo any accepted group change."});
      },()=>publish({...state,message:"The saved request cannot be cleared yet. Retry recovery; it may still apply or the source may be unavailable."}));
    },
    inspectSharing(tenant:string) {
      if(state.deletion)return Promise.resolve();
      return operation(async(signal,current)=>{
        const sharing=await browser.pendingShare(tenant,signal);
        if(current())publish({...state,sharing,message:sharing?"A sharing change is saved. Resume to confirm it.":"No pending sharing change."});
      });
    },
    share(tenant:string,object:string,reader:string) {
      if(state.deletion||state.itemWrap||state.sharing||state.audience?.object!==object||!state.objects.includes(object)||!owner||!isSeaPubkey(reader)||reader===owner)return Promise.resolve();
      const principal=owner;
      return operation(async(signal,current)=>{
        const result=await browser.share(tenant,{object,owner:principal,reader},signal);
        if(current())publish({...state,audience:null,sharing:result.pending?{object,reader,token:result.token,...(result.remove?{remove:true}:{})}:null,
          message:result.pending?"Sharing is saved but not yet confirmed. Resume after the access update settles.":"Sharing confirmed. Recipient access uses fresh authorization."});
      },()=>publish({...state,sharing:null,message:"Sharing could not be confirmed. Check saved sharing before retrying; accepted changes are not undone."}));
    },
    resumeSharing(tenant:string) {
      if(state.deletion||state.itemWrap||!state.sharing)return Promise.resolve();
      const selected={...state.sharing};
      return operation(async(signal,current)=>{
        const result=await browser.resumeShare(tenant,selected,signal);
        if(current())publish({...state,audience:null,sharing:result.pending?{object:result.object,reader:result.reader,token:result.token,...(result.remove?{remove:true}:{})}:null,
          message:result.pending?"Sharing is still pending. Future access times and settlement can delay completion.":"Sharing confirmed."});
      },()=>publish({...state,message:"Sharing could not be confirmed. The saved change is retained; check access and retry."}));
    },
    abandonSharing(tenant:string) {
      if(state.deletion||state.itemWrap||!state.sharing)return Promise.resolve();
      const selected={...state.sharing};
      return operation(async(signal,current)=>{
        await browser.abandonShare(tenant,selected,signal);
        if(current())publish({...state,sharing:null,message:"Local sharing recovery forgotten. Accepted access changes were not undone; inspect this file's sharing."});
      },()=>publish({...state,message:"Saved sharing changed or could not be removed. Inspect it again before forgetting it."}));
    },
    recipients(object: string) {
      if(state.deletion || !state.objects.includes(object) || !owner)return Promise.resolve();
      const principal=owner;
      return operation(async(signal,current)=>{
        const readers=(await browser.recipients(object,principal,signal)).filter(reader=>reader!==principal);
        if(current())publish({...state,audience:{object,readers}});
      });
    },
    unshare(tenant:string,object:string,reader:string) {
      if(state.deletion||state.itemWrap||state.sharing||state.audience?.object!==object||!state.audience.readers.includes(reader)||!owner)return Promise.resolve();
      const principal=owner;
      return operation(async(signal,current)=>{
        const result=await browser.share(tenant,{object,owner:principal,reader,remove:true},signal);
        if(current())publish({...state,audience:null,sharing:result.pending?{object,reader,token:result.token,remove:true}:null,
          message:result.pending?"Removal is saved. Resume to finish the remaining readers' access update.":"Sharing stopped for this identity. Copies already saved cannot be removed."});
      },()=>publish({...state,sharing:null,message:"Removal could not be confirmed. Check saved sharing before retrying; accepted changes are not undone."}));
    },
    cancel(object: string, reader: string) {
      if(state.deletion || state.audience?.object!==object || !state.audience.readers.includes(reader))return Promise.resolve();
      return operation(async(signal,current)=>{
        await browser.cancel(object,reader,signal);
        if(current())publish({...state,audience:null,message:"Sharing stopped for this identity. Copies already saved cannot be removed."});
      });
    },
    open(object: string, tenant: string) {
      if(state.deletion || (!state.objects.includes(object) && !state.granted?.objects.includes(object)))return Promise.resolve();
      return openAuthorized(object,tenant);
    },
    /** A signed room reference is a locator, never read authority. The browser's
     * existing read-wrap path checks current access before fetching ciphertext. */
    openReference(object: string, tenant: string) {
      if(state.deletion || !object.startsWith("media_") || !isCanonicalObjectId(object))return Promise.resolve();
      return openAuthorized(object,tenant);
    },
    dispose() { if(disposed)return;disposed=true;unsubscribe();reset(); },
  });
}
