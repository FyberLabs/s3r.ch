"use client";

import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import type { DrawerAuthority } from "@/lib/forum-drawer";
import { SquadDelegationProvider } from "./SquadDelegationProvider";
import type { ForumAuthoritySource } from "@/lib/forum-authority-source";
export type { ForumAuthoritySource } from "@/lib/forum-authority-source";
import { createForumAuthority, type ForumAuthorityConfig } from "@/lib/identity/forum-authority";

const denyConfig: ForumAuthorityConfig = { keys: [], policy: { allowedDomains: [], allowedUris: [], allowedChainIds: [] }, pinnedIssuers: [] };
const Context = createContext<(ReturnType<typeof createForumAuthority> & Pick<DrawerAuthority, "publishChild" | "readChild"> & { admitStatement?: (item: Parameters<NonNullable<ForumAuthoritySource["admitStatement"]>>[0]) => Promise<boolean> }) | null>(null);
export function ForumAuthorityProvider({ children, source }: { children: ReactNode; source?: ForumAuthoritySource }) {
  const authority = useMemo(() => {
    const current = createForumAuthority(source?.config ?? denyConfig);
    let epoch = 0;
    return { ...current, invalidate() { epoch++; current.invalidate(); },
    admitStatement: source?.admitStatement ? async (item: Parameters<NonNullable<ForumAuthoritySource["admitStatement"]>>[0]) => {
      const started = epoch;
      const admitted = await source.admitStatement!(item);
      if (epoch !== started) return false;
      const result = await current.refresh(admitted.snapshot, admitted.at);
      return epoch === started && result.ok && !result.diagnostics.length;
    } : undefined,
    readChild: source?.assignments ? ((scope, id) => source.assignments!.readChild(scope, id)) as NonNullable<DrawerAuthority["readChild"]> : undefined,
    publishChild: source?.assignments ? ((record, signature) => source.assignments!.publishChild(
      { forum: record.forumId, owner: record.agent }, record, signature)) as NonNullable<DrawerAuthority["publishChild"]> : undefined,
    };
  }, [source]);
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
