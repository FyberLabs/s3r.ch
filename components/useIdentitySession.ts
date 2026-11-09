"use client";

import { useEffect, useState } from "react";

export type IdentitySession = {
  /** Wallet that signed. Gun mesh key stays here. */
  address: string;
  /** Sociacl owner of Gun and Check objects. A linked handle resolves here. */
  owner: string;
  chainId: number;
};

export function objectOwner(session: IdentitySession): string {
  return session.owner || session.address;
}

export function useIdentitySessionState(enabled = true) {
  const [session, setSession] = useState<IdentitySession | null>();
  useEffect(() => {
    if (!enabled) {
      setSession(undefined);
      return;
    }
    let request: AbortController;
    async function refresh() {
      request?.abort();
      const controller = new AbortController();
      request = controller;


      try {
        const response = await fetch("/api/identity/session", { cache: "no-store", signal: controller.signal });
        if (controller.signal.aborted) return;
        if (!response.ok) {
          setSession(null);
          return;
        }
        const payload = (await response.json()) as Partial<IdentitySession>;
        if (controller.signal.aborted) return;
        if (typeof payload.address === "string" && payload.address) {
          const owner =
            typeof payload.owner === "string" && payload.owner ? payload.owner : payload.address;
          setSession({
            address: payload.address,
            owner,
            chainId: typeof payload.chainId === "number" ? payload.chainId : 1,
          });
          return;
        }
        setSession(null);
      } catch {
        if (!controller.signal.aborted) setSession(null);
      }
    }
    void refresh();
    const onVis = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVis);
    const timer = window.setInterval(() => void refresh(), 4000);
    return () => {
      request?.abort();
      document.removeEventListener("visibilitychange", onVis);
      window.clearInterval(timer);
    };
  }, [enabled]);

  return enabled ? session : undefined;
}

export function useIdentitySession(enabled = true): IdentitySession | null {
  return useIdentitySessionState(enabled) ?? null;
}
