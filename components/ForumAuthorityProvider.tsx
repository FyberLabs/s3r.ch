"use client";

import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { createForumAuthority, type ForumAuthorityConfig, type ForumAuthoritySnapshot } from "@/lib/identity/forum-authority";

/** Provisioned source contract for #190. Never build this from legacy IndexedDB
 * ownership or a peer's self-reported completeness flag. The application must
 * arrange fresh snapshots for each evaluation second and signal invalidation. */
export type ForumAuthoritySource = Readonly<{
  config: ForumAuthorityConfig;
  subscribe(receive: (snapshot: ForumAuthoritySnapshot | null, at: number) => void): () => void;
}>;
const denyConfig: ForumAuthorityConfig = { keys: [], policy: { allowedDomains: [], allowedUris: [], allowedChainIds: [] }, pinnedIssuers: [] };
const Context = createContext<ReturnType<typeof createForumAuthority> | null>(null);
export function ForumAuthorityProvider({ children, source }: { children: ReactNode; source?: ForumAuthoritySource }) {
  const authority = useMemo(() => createForumAuthority(source?.config ?? denyConfig), [source]);
  useEffect(() => {
    if (!source) return;
    let active = true;
    const unsubscribe = source.subscribe((snapshot, at) => {
      if (!active) return;
      if (snapshot) void authority.refresh(snapshot, at);
      else authority.invalidate();
    });
    return () => { active = false; unsubscribe(); authority.invalidate(); };
  }, [source, authority]);
  return <Context.Provider value={authority}>{children}</Context.Provider>;
}
export const useForumAuthority = () => useContext(Context);
