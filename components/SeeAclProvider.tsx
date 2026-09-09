"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  createMeshAclIndex,
  type MeshAclIndex,
} from "@/lib/identity/mesh-acl";
import {
  createMemorySeeAcl,
  hydrateSeeAcl,
  persistSeeAcl,
  type MemorySeeAcl,
} from "@/lib/identity/see-acl";

export type SeeAclContextValue = {
  acl: MemorySeeAcl;
  mesh: MeshAclIndex;
  ready: boolean;
  persist: () => Promise<void>;
};

const SeeAclContext = createContext<SeeAclContextValue | null>(null);

export function SeeAclProvider({ children }: { children: ReactNode }) {
  const [acl] = useState<MemorySeeAcl>(() => createMemorySeeAcl());
  const [mesh] = useState<MeshAclIndex>(() => createMeshAclIndex());
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void hydrateSeeAcl(acl)
      .catch(() => acl)
      .then(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [acl]);

  const persist = useCallback(async () => {
    try {
      await persistSeeAcl(acl);
    } catch {
      // Private mode / missing IndexedDB — stay in memory.
    }
  }, [acl]);

  const value = useMemo(
    () => ({ acl, mesh, ready, persist }),
    [acl, mesh, ready, persist],
  );

  return (
    <SeeAclContext.Provider value={value}>{children}</SeeAclContext.Provider>
  );
}

export function useSeeAcl(): SeeAclContextValue | null {
  return useContext(SeeAclContext);
}
