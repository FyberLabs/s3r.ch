import {createPrivateMediaBrowser} from './media-browser-session';
import {collectionKey,type ForumCollection} from './forum-collections';
import type {GroupGrantedEntry} from './media-group-item-catalog';
import {mediaPreviewKind} from './media-preview';
export type ForumMemoryState={busy:boolean;loaded:boolean;page:number;nextPage:number|null;entries:readonly GroupGrantedEntry[];
  preview:null|{url:string;name:string;mediaType:string};message:string};
const empty=():ForumMemoryState=>({busy:false,loaded:false,page:0,nextPage:null,entries:[],preview:null,message:''});
/** Read-only composition. Forum references and the current media catalog must
 * intersect; opening still goes through independent item/group authorization. */
export function createForumMemory(input:{key:string;tenant:string;current():boolean;collections():readonly ForumCollection[];changed(state:ForumMemoryState):void},options:{
  browser?:typeof createPrivateMediaBrowser;makeUrl?:(blob:Blob)=>string;revokeUrl?:(url:string)=>void;clock?:()=>number;
}={}){
  const browser=(options.browser??createPrivateMediaBrowser)(()=>input.current()?input.key:null),clock=options.clock??Date.now;
  const makeUrl=options.makeUrl??URL.createObjectURL,revokeUrl=options.revokeUrl??URL.revokeObjectURL;
  let state=empty(),controller:AbortController|null=null,disposed=false,generation=0,until=0,opened:GroupGrantedEntry|null=null;
  const linked=(entry:GroupGrantedEntry)=>input.collections().some(scope=>collectionKey(scope)===collectionKey(entry));
  function lease(at:number){const now=clock(),end=Math.min(now+4000,at*1000+4000);if(end<=now)throw Error('Catalog expired');return end;}
  function publish(next:ForumMemoryState){state=next;if(!disposed)input.changed(next);}
  function clearPreview(){if(state.preview)revokeUrl(state.preview.url);opened=null;}
  function reset(message=''){generation++;controller?.abort();controller=null;until=0;clearPreview();publish({...empty(),message});}
  function check(){if(disposed||!input.current())throw Error('Forum access changed');}
  async function run(work:(signal:AbortSignal,valid:()=>void)=>Promise<void>){
    if(disposed||controller)return;const held=++generation,abort=new AbortController();controller=abort;
    const signal=AbortSignal.any([abort.signal,AbortSignal.timeout(120000)]);
    const valid=()=>{check();signal.throwIfAborted();if(generation!==held)throw Error('Memory view changed');};
    publish({...state,busy:true,message:''});
    try{valid();await work(signal,valid);valid();}catch{if(!disposed&&held===generation)reset('Media unavailable. Refresh to check your current access.');}
    finally{if(controller===abort){controller=null;publish({...state,busy:false});}}
  }
  const api = {
    reset,
    refreshIfLoaded():Promise<void>{return state.loaded ? api.refresh() : Promise.resolve();},
    refresh(page=state.page){return run(async(signal,valid)=>{
      const result=await browser.groupGrantedCatalog(input.key,page,signal);valid();
      const entries=result.entries;
      if(opened&&(!linked(opened)||!entries.some(row=>row.object===opened!.object&&collectionKey(row)===collectionKey(opened!))))clearPreview();
      until=lease(result.at);
      publish({...state,loaded:true,page,nextPage:result.nextPage,entries,preview:opened?state.preview:null});
    });},
    open(entry:GroupGrantedEntry){const held={...entry};return run(async(signal,valid)=>{
      clearPreview();publish({...state,preview:null});
      if(clock()>=until||!linked(held)||!state.entries.some(row=>row.object===held.object&&collectionKey(row)===collectionKey(held)))throw Error('Refresh required');
      const page=state.page;until=0;publish({...state,entries:[],loaded:false});
      const file=await browser.openGroup(held.object,input.tenant,input.key,{predicate:held.predicate,set:held.set},signal);
      try{valid();if(!linked(held))throw Error('Collection removed');
        const catalog=await browser.groupGrantedCatalog(input.key,page,signal);valid();
        const entries=catalog.entries;
        if(!linked(held)||!entries.some(row=>row.object===held.object&&collectionKey(row)===collectionKey(held)))throw Error('Grant changed');
        if(!['image','video'].includes(mediaPreviewKind(file.description.mediaType)??''))throw Error('Not a photo or video');
        until=lease(catalog.at);
        const url=makeUrl(new Blob([new Uint8Array(file.bytes)],{type:file.description.mediaType}));
        opened=held;publish({...state,entries,loaded:true,preview:{url,name:file.description.name,mediaType:file.description.mediaType}});
      }finally{file.bytes.fill(0);}
    });},
    /** Host checks frequently; retained plaintext never outlives a catalog lease. */
    tick(){if(disposed)return;if((!input.current()&&(state.loaded||state.busy))||(until&&clock()>=until)||(opened&&!linked(opened)))reset();},
    dispose(){if(disposed)return;reset();disposed=true;},
  };
  return api;
}
