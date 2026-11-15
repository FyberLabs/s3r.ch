import {signPrivateMediaGroupConfig} from "sociacl-ids/private-media";
import {signMembershipAssent,membershipSoul} from "sociacl-ids/group-signing";
import {parseMediaGroupScope,type MediaGroupScope} from "./media-group";
import {parseGroupCommand,parseGroupCommandResult,type GroupCommandAction,type GroupCatalog} from "./media-group-command";
import {readBoundedIdentityJson} from "./identity/bounded-json";
import {isSeaPubkey} from "./identity/forum-check";

export type GroupSignedCommand=Readonly<{kind:"create"|"member";body:Record<string,unknown>}>;
type GroupCommandState={at:number;state:"applied"|"absent";fence?:string};
const fail=():never=>{throw Error("Group command could not be confirmed");};
export function parseSignedGroupCommand(input:unknown,principal:string):GroupSignedCommand {
  const command=structuredClone(input) as GroupSignedCommand;
  if(!command||typeof command!=="object"||Array.isArray(command)||Object.keys(command).length!==2||
      !Object.hasOwn(command,"kind")||!Object.hasOwn(command,"body")||!["create","member"].includes(command.kind))return fail();
  return {kind:command.kind,body:parseGroupCommand(command.kind==="create"?"create-state":"member-state",command.body,principal)};
}

/** Sign only a fresh protected draft; applying a saved command never signs again. */
export function createGroupCommandClient(principal:string,fetcher:typeof fetch=fetch,clock=()=>Date.now()/1000) {
  if(!isSeaPubkey(principal))return fail();
  async function request(action:GroupCommandAction,body:Record<string,unknown>,signal:AbortSignal) {
    const held=parseGroupCommand(action,body,principal),raw=JSON.stringify(held);
    if(new TextEncoder().encode(raw).length>18432)return fail();
    signal.throwIfAborted();
    const response=await fetcher("/api/media/groups/"+action,{method:"POST",credentials:"same-origin",redirect:"error",cache:"no-store",signal,
      headers:{"Content-Type":"application/json"},body:raw});
    if(response.status!==200||response.headers.get("content-type")?.split(";")[0]!=="application/json"){
      await response.body?.cancel().catch(()=>{});return fail();
    }
    const result=parseGroupCommandResult(action,await readBoundedIdentityJson(response,18432,signal),held,clock(),principal);
    signal.throwIfAborted();return result;
  }
  function deadline(signal?:AbortSignal){return AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(4000)]);}
  async function withKey<T>(scalar:Uint8Array,signal:AbortSignal|undefined,work:(key:Uint8Array,signal:AbortSignal)=>Promise<T>) {
    if(!(scalar instanceof Uint8Array)||scalar.length!==32)return fail();
    const key=new Uint8Array(scalar),held=deadline(signal);
    try{held.throwIfAborted();const result=await work(key,held);held.throwIfAborted();return result;}finally{key.fill(0);}
  }
  async function state(command:GroupSignedCommand,signal:AbortSignal) {
    return await request(command.kind==="create"?"create-state":"member-state",command.body,signal) as GroupCommandState;
  }
  return Object.freeze({
    catalog(page=0,signal?:AbortSignal){return request("catalog",{page},deadline(signal)) as Promise<GroupCatalog>;},
    prepareCreate(object:string,scope:MediaGroupScope,settleWindowMs:number,scalar:Uint8Array,signal?:AbortSignal){
      const held=parseMediaGroupScope(scope);
      if(!Number.isSafeInteger(settleWindowMs)||settleWindowMs<3600000||settleWindowMs>259200000)return Promise.reject(Error("Invalid group settle window"));
      return withKey(scalar,signal,async(key,signal)=>{
        const view=await request("create-view",{object,...held},signal),context=view.context as Record<string,string>;
        const config=signPrivateMediaGroupConfig({owner:principal,setId:held.set,predicate:held.predicate,settleWindowMs,configRevision:0},key,context.ownerPub);
        signal.throwIfAborted();return parseSignedGroupCommand({kind:"create",body:{object,...held,config}},principal);
      });
    },
    prepareMember(scope:MediaGroupScope,member:string,role:"member"|"set",stated:0|1,scalar:Uint8Array,signal?:AbortSignal){
      const held=parseMediaGroupScope(scope);
      return withKey(scalar,signal,async(key,signal)=>{
        const body={...held,member,role,stated},view=await request("member-view",body,signal);
        const record=signMembershipAssent(view.draft,key,view.signerPub as string);
        signal.throwIfAborted();
        return parseSignedGroupCommand({kind:"member",body:{...held,member,role,row:{kind:"membership",record,
          soul:membershipSoul(record.setOwner,record.predicate,record.set,record.member)}}},principal);
      });
    },
    state(input:GroupSignedCommand,signal?:AbortSignal){const command=parseSignedGroupCommand(input,principal);return state(command,deadline(signal));},
    async apply(input:GroupSignedCommand,signal?:AbortSignal,beforeAppend?:(at:number)=>Promise<void>){
      const command=parseSignedGroupCommand(input,principal),held=deadline(signal),current=await state(command,held);
      if(current.state==="applied")return;
      if(command.kind==="member"){
        const row=command.body.row as {record:{issuedAt:number}};
        if(current.at-row.record.issuedAt<0||current.at-row.record.issuedAt>4)return fail();
      }
      if(beforeAppend)await beforeAppend(current.at);
      held.throwIfAborted();
      await request(command.kind==="create"?"create":"member-append",{...command.body,at:current.at,fence:current.fence},held);
    },
  });
}
