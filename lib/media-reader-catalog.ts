import { isMediaCatalogPageNumber, parseMediaGrantedPage } from "./media-catalog";
import { isSeaPubkey } from "./identity/forum-check";
import { readBoundedIdentityJson } from "./identity/bounded-json";

export async function readGrantedMedia(page:number,fetcher:typeof fetch=fetch,signal?:AbortSignal) {
  if(!isMediaCatalogPageNumber(page))throw Error("Invalid granted media page");
  const deadline=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(4000)]);
  deadline.throwIfAborted();
  const response=await fetcher("/api/media/catalog",{method:"POST",credentials:"same-origin",redirect:"error",cache:"no-store",
    headers:{"Content-Type":"application/json"},body:JSON.stringify({page}),signal:deadline});
  if(response.status!==200 || response.headers.get("content-type")?.split(";")[0]!=="application/json") {
    await response.body?.cancel().catch(()=>{});throw Error("Granted media unavailable");
  }
  const value=await readBoundedIdentityJson(response,4096,deadline) as Record<string,unknown>;
  deadline.throwIfAborted();
  if(!value || typeof value!=="object" || Object.keys(value).sort().join()!=="at,nextPage,objects,principal" ||
      typeof value.principal!=="string" || !isSeaPubkey(value.principal))throw Error("Invalid granted media catalog");
  const {principal,...catalog}=value;
  return {...parseMediaGrantedPage(catalog,page,principal),principal};
}
