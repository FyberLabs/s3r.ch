type GunHealth = {status:"external";health:"ok"|"unavailable"|"not-configured";checkedAt:string|null};
/** Operator-configured peer probe; never derive its URL from a request header. */
export function createGunHealthProbe(fetcher: typeof fetch = fetch, clock = Date.now) {
  let held: {url:string;at:number;value:GunHealth}|undefined;
  let pending: {url:string;value:Promise<GunHealth>}|undefined;
  async function check(raw:string): Promise<GunHealth> {
    const checkedAt=new Date(clock()).toISOString();
    try {
      const url=new URL(raw);
      if (url.protocol!=="https:" || url.username || url.password || url.search || url.hash ||
          !["/api/health","/_peer/api/health"].includes(url.pathname)) throw Error();
      const response=await fetcher(url,{cache:"no-store",redirect:"error",credentials:"omit",signal:AbortSignal.timeout(1500)});
      if(response.status!==200||!response.body) {void response.body?.cancel().catch(()=>{});throw Error();}
      const reader=response.body.getReader();let bytes=0;const chunks:Uint8Array[]=[];
      try {
        while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>4096)throw Error();chunks.push(part.value);}
      } finally {void reader.cancel().catch(()=>{});}
      const buffer=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){buffer.set(chunk,offset);offset+=chunk.length;}
      const result=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(buffer));
      if(result.status!=="ok"||result.dependencies?.gun?.status!=="ok")throw Error();
      return {status:"external",health:"ok",checkedAt};
    } catch {return {status:"external",health:"unavailable",checkedAt};}
  }
  return async (url:string|undefined):Promise<GunHealth> => {
    if(!url)return {status:"external",health:"not-configured",checkedAt:null};
    if(held?.url===url && clock()>=held.at && clock()-held.at<15_000)return held.value;
    if(pending?.url===url)return pending.value;
    const value=check(url).then(value=>{held={url,at:clock(),value};return value;});
    const next={url,value};pending=next;
    try{return await value;}finally{if(pending===next)pending=undefined;}
  };
}
export const gunHealth=createGunHealthProbe();
