import {wrapGroupKeyToMembers,openGroupKeyReaderWrap} from "sociacl-ids/group-reader-wrap";
import {groupKeySnapshotId,type PrivateGroupSnapshot,type PrivateMediaManifest} from "sociacl-ids/private-media";
import {parseMediaGroupScope,type MediaGroupScope} from "./media-group";
import {parseGroupCommand,parseGroupCommandResult,groupRequestLimit,groupResponseLimit} from "./media-group-command";
import type {GroupWrapAction} from "./media-group-wrap";
import {readBoundedIdentityJson} from "./identity/bounded-json";
import {shareDigest} from "./media-share-journal";
import {isSeaPubkey} from "./identity/forum-check";

export type PreparedGroupWrap=Readonly<{metadata:Readonly<{reader:string;readerEpub:string;epoch:number;revisionId:string;digest:string}>;payload:string}>;
export type GroupWrapBundle=MediaGroupScope & Readonly<{version:1;epoch:number;revisionId:string;keyCommitment:string;aclSnapshot:string;wraps:readonly PreparedGroupWrap[]}>;
const fail=():never=>{throw Error("Group key delivery could not be confirmed");};
const digest=(s:unknown):s is string=>typeof s==="string"&&/^[a-f0-9]{64}$/.test(s);
const exact=(v:unknown,keys:readonly string[]):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const encode=(raw:Uint8Array)=>{let text="";for(const byte of raw)text+=String.fromCharCode(byte);return btoa(text);};
const decode=(text:string)=>Uint8Array.from(atob(text),c=>c.charCodeAt(0));

/** Validate saved ciphertext before any retry; never manufacture replacement wraps. */
export async function parseGroupWrapBundle(value:unknown,principal:string):Promise<GroupWrapBundle>{
  const b=structuredClone(value);
  if(!exact(b,["version","predicate","set","epoch","revisionId","keyCommitment","aclSnapshot","wraps"])||b.version!==1||
      !Number.isSafeInteger(b.epoch)||(b.epoch as number)<1||!digest(b.revisionId)||!digest(b.keyCommitment)||!digest(b.aclSnapshot)||
      !Array.isArray(b.wraps)||b.wraps.length<1||b.wraps.length>64)return fail();
  const scope=parseMediaGroupScope({predicate:b.predicate,set:b.set});
  parseGroupCommand("wrap-view",scope,principal);
  let previous="";
  for(const entry of b.wraps){
    if(!exact(entry,["metadata","payload"]))return fail();
    const body=parseGroupCommand("wrap-publish",{...scope,at:0,fence:"0".repeat(64),...entry},principal);
    const m=body.metadata as PreparedGroupWrap["metadata"];
    if(m.reader<=previous||m.epoch!==b.epoch||m.revisionId!==b.revisionId)return fail();
    previous=m.reader;
    const bytes=decode(body.payload as string);
    if(await shareDigest(bytes)!==m.digest)return fail();
    const wrap=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
    if(!exact(wrap,["epoch","group","revisionId","scope","target","targetId","wrappedKey"])||
        wrap.epoch!==b.epoch||wrap.group!==scope.set||wrap.revisionId!==b.revisionId||wrap.scope!=="group-key"||
        wrap.target!=="reader-epub"||wrap.targetId!==m.readerEpub||typeof wrap.wrappedKey!=="string"||
        !/^(?:[a-f0-9]{2})+$/.test(wrap.wrappedKey))return fail();
  }
  return b as GroupWrapBundle;
}

export function createGroupWrapClient(principal:string,fetcher:typeof fetch=fetch,clock=()=>Date.now()/1000){
  if(!isSeaPubkey(principal))return fail();
  const deadline=(signal?:AbortSignal)=>AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(4000)]);
  async function request(action:GroupWrapAction,body:Record<string,unknown>,signal:AbortSignal){
    const parsed=parseGroupCommand(action,body,principal),raw=JSON.stringify(parsed);
    if(new TextEncoder().encode(raw).length>groupRequestLimit(action))return fail();
    signal.throwIfAborted();
    const response=await fetcher('/api/media/groups/'+action,{method:'POST',credentials:'same-origin',redirect:'error',cache:'no-store',signal,
      headers:{'Content-Type':'application/json'},body:raw});
    if(response.status!==200||response.headers.get('content-type')?.split(';')[0]!=="application/json"){
      await response.body?.cancel().catch(()=>{});return fail();
    }
    const result=parseGroupCommandResult(action,await readBoundedIdentityJson(response,groupResponseLimit(action),signal),parsed,clock(),principal);
    signal.throwIfAborted();return result;
  }
  return Object.freeze({
    async prepare(scope:MediaGroupScope,key:Uint8Array,signal?:AbortSignal):Promise<GroupWrapBundle>{
      if(!(key instanceof Uint8Array)||key.length!==32)return fail();
      const secret=new Uint8Array(key),held=deadline(signal);
      try{
        scope=parseMediaGroupScope(scope);
        const view=await request('wrap-view',scope,held);
        const snapshot=view.snapshot as PrivateGroupSnapshot,manifest=view.manifest as PrivateMediaManifest;
        if(groupKeySnapshotId(snapshot)!==manifest.aclSnapshot||await shareDigest(secret)!==manifest.keyCommitment)return fail();
        const members=snapshot.members.filter(m=>m.stated===1);
        if(!members.length)return fail();
        const wrapped=await wrapGroupKeyToMembers(secret,{group:scope.set,epoch:manifest.epoch,revisionId:manifest.revisionId},
          members.map(m=>({account:m.accessor,pub:m.signingPub,identityPub:m.signingPub,epub:m.encryptionPub})),members.map(m=>m.accessor));
        if(!wrapped.ok||wrapped.value.length!==members.length)return fail();
        const wraps:PreparedGroupWrap[]=[];
        for(let i=0;i<members.length;i++){
          const raw=new TextEncoder().encode(JSON.stringify(wrapped.value[i]));
          wraps.push({metadata:{reader:members[i].accessor,readerEpub:members[i].encryptionPub,epoch:manifest.epoch,
            revisionId:manifest.revisionId,digest:await shareDigest(raw)},payload:encode(raw)});
        }
        held.throwIfAborted();
        return await parseGroupWrapBundle({...scope,version:1,epoch:manifest.epoch,revisionId:manifest.revisionId,
          keyCommitment:manifest.keyCommitment,aclSnapshot:manifest.aclSnapshot,wraps},principal);
      }finally{secret.fill(0);}
    },
    async publish(input:GroupWrapBundle,index:number,signal?:AbortSignal){
      const bundle=await parseGroupWrapBundle(input,principal),held=deadline(signal);
      if(!Number.isSafeInteger(index)||index<0||index>=bundle.wraps.length)return fail();
      const scope=parseMediaGroupScope({predicate:bundle.predicate,set:bundle.set});
      const view=await request('wrap-view',scope,held),manifest=view.manifest as PrivateMediaManifest,snapshot=view.snapshot as PrivateGroupSnapshot;
      const entry=bundle.wraps[index],member=snapshot.members.find(m=>m.accessor===entry.metadata.reader&&m.stated===1);
      if(manifest.epoch!==bundle.epoch||manifest.revisionId!==bundle.revisionId||manifest.keyCommitment!==bundle.keyCommitment||
          manifest.aclSnapshot!==bundle.aclSnapshot||groupKeySnapshotId(snapshot)!==bundle.aclSnapshot||member?.encryptionPub!==entry.metadata.readerEpub)return fail();
      await request('wrap-publish',{...scope,at:view.at,fence:view.fence,...entry},held);
    },
    async open(scope:MediaGroupScope,epriv:string,epub:string,signal?:AbortSignal){
      scope=parseMediaGroupScope(scope);
      const held=deadline(signal),value=await request('wrap-read',scope,held);
      if(value.reader_epub!==epub)return fail();
      const wrap=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(decode(value.payload as string)));
      const opened=await openGroupKeyReaderWrap(wrap,epriv,epub,{group:scope.set,epoch:value.epoch,revisionId:value.revision_id});
      if(!opened.ok)return fail();
      try{
        if(await shareDigest(opened.value)!==value.key_commitment||clock()>=(value.expires_at as number))return fail();
        held.throwIfAborted();return opened.value;
      }catch(error){opened.value.fill(0);throw error;}
    },
  });
}
