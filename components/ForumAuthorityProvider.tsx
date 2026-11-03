"use client";

import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import type { DrawerAuthority } from "@/lib/forum-drawer";
import { SquadDelegationProvider } from "./SquadDelegationProvider";
import type { AssignmentClient } from "@/lib/assignment-client";
import { createForumAuthority, type ForumAuthorityConfig, type ForumAuthoritySnapshot } from "@/lib/identity/forum-authority";

/** Provisioned source contract for #190. Never build this from legacy IndexedDB
 * ownership or a peer's self-reported completeness flag. The application must
 * arrange fresh snapshots for each evaluation second and signal invalidation. */
export type ForumAuthoritySource = Readonly<{
  config: ForumAuthorityConfig;
  assignments?: AssignmentClient;
  subscribe(receive: (snapshot: ForumAuthoritySnapshot | null, at: number) => void): () => void;
}>;
const denyConfig: ForumAuthorityConfig = { keys: [], policy: { allowedDomains: [], allowedUris: [], allowedChainIds: [] }, pinnedIssuers: [] };
const Context = createContext<(ReturnType<typeof createForumAuthority> & Pick<DrawerAuthority, "publishChild" | "readChild">) | null>(null);
export function ForumAuthorityProvider({ children, source }: { children: ReactNode; source?: ForumAuthoritySource }) {
  const authority = useMemo(() => ({ ...createForumAuthority(source?.config ?? denyConfig),
    readChild: source?.assignments ? ((scope, id) => source.assignments!.readChild(scope, id)) as NonNullable<DrawerAuthority["readChild"]> : undefined,
    publishChild: source?.assignments ? ((record, signature) => source.assignments!.publishChild(
      { forum: record.forumId, owner: record.agent }, record, signature)) as NonNullable<DrawerAuthority["publishChild"]> : undefined,
  }), [source]);
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
  return <Context.Provider value={authority}><SquadDelegationProvider client={source?.assignments}>{children}</SquadDelegationProvider></Context.Provider>;
}
export const useForumAuthority = () => useContext(Context);
