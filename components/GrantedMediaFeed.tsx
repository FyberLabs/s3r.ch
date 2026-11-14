"use client";
import { useMediaTenant } from "./useMediaTenant";
import { GrantedMediaPanel } from "./GrantedMediaPanel";

/** The public feed shell stays static; routing metadata is read only in Granted. */
export function GrantedMediaFeed() {
  const tenant=useMediaTenant();
  if(tenant===undefined)return <p role="status">Loading private media availability…</p>;
  if(!tenant)return <p>Private media is not available on this site yet.</p>;
  return <GrantedMediaPanel key={tenant} tenant={tenant}/>;
}
