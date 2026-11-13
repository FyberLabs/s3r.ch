import type Hls from "hls.js";
type HlsModule = {default: typeof Hls};
/** Controller owns exactly one player; async imports cannot resurrect a removed element. */
export function attachPublicHls(element: HTMLVideoElement, source: string, origin: string,
  failure: () => void, load: () => Promise<HlsModule> = () => import("hls.js")) {
  let disposed=false,requested=false,player:Hls|null=null;
  const native=Boolean(element.canPlayType("application/vnd.apple.mpegurl"));
  if(native)element.src=source;
  else void load().then(({default:Hls})=>{
    if(disposed)return;
    if(!Hls.isSupported()){failure();return;}
    player=new Hls({enableWorker:false,autoStartLoad:false,maxBufferLength:30,maxMaxBufferLength:60,
      xhrSetup:(_xhr,target)=>{
        const request=new URL(target,origin);
        if(request.origin!==origin || request.pathname!=="/api/feed/media")throw new Error("Non-proxy media request refused");
      }});
    player.on(Hls.Events.ERROR,(_event,data)=>{if(!disposed && data.fatal)failure();});
    player.attachMedia(element);player.loadSource(source);
    if(requested)player.startLoad();
  }).catch(()=>{if(!disposed)failure();});
  return {
    start(){if(disposed)return;requested=true;player?.startLoad();},
    destroy(){if(disposed)return;disposed=true;player?.destroy();player=null;if(native){element.removeAttribute("src");element.load();}},
  };
}
