"use client";
import { useEffect, useState } from "react";
import { readBoundedIdentityJson } from "@/lib/identity/bounded-json";
import { GrantedMediaPanel } from "./GrantedMediaPanel";

/** The public feed shell stays static; routing metadata is read only in Granted. */
export function GrantedMediaFeed() {
  const [tenant,setTenant]=useState<string|null|undefined>(undefined);
  useEffect(()=>{
    const controller=new AbortController();
    const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(4000)]);
    void (async()=>{
      try {
        const response=await fetch("/api/media/config",{cache:"no-store",credentials:"same-origin",redirect:"error",signal});
        if(!response.ok || response.headers.get("content-type")?.split(";")[0]!=="application/json") {
          await response.body?.cancel().catch(()=>{});throw Error("Media configuration unavailable");
        }
        const value=await readBoundedIdentityJson(response,1024,signal) as Record<string,unknown>;
        if(!value || Object.keys(value).join()!=="tenant" || typeof value.tenant!=="string" ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.tenant))throw Error("Media unavailable");
        if(!controller.signal.aborted)setTenant(value.tenant);
      }catch{if(!controller.signal.aborted)setTenant(null);}
    })();
    return ()=>controller.abort();
  },[]);
  if(tenant===undefined)return <p role="status">Loading private media availability…</p>;
  if(!tenant)return <p>Private media is not available on this site yet.</p>;
  return <GrantedMediaPanel key={tenant} tenant={tenant}/>;
}
