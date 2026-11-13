"use client";
import { useEffect, useState } from "react";
import { privacyPreferences } from "@/lib/privacy-preferences";
import { readBoundedIdentityJson } from "@/lib/identity/bounded-json";
export function PrivacyPreferences() {
  const [detected,setDetected]=useState(false);
  useEffect(()=>{
    const local=privacyPreferences(null,(navigator as Navigator & {globalPrivacyControl?:boolean}).globalPrivacyControl);
    setDetected(local.globalPrivacyControl);
    const controller=new AbortController();
    const deadline=AbortSignal.any([controller.signal,AbortSignal.timeout(4000)]);
    void fetch("/api/privacy/preferences",{cache:"no-store",credentials:"omit",redirect:"error",signal:deadline})
      .then(async response=>{
        if(response.ok)return readBoundedIdentityJson(response,1024,deadline);
        await response.body?.cancel();return null;
      })
      .then(value=>{if(!controller.signal.aborted && value && typeof value==="object" && "globalPrivacyControl" in value && value.globalPrivacyControl===true)setDetected(true);})
      .catch(()=>{});
    return ()=>controller.abort();
  },[]);
  return <p role="status">{detected ? "Global Privacy Control detected. Your opt-out applies to sale and sharing." : "Sale and cross-context advertising sharing are off for everyone."}</p>;
}
