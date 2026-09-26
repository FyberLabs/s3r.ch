"use client";

import { useCallback, useEffect, useState } from "react";

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

export function useIdentitySession(): IdentitySession | null {
  const [session, setSession] = useState<IdentitySession | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/identity/session", { cache: "no-store" });
      if (!response.ok) {
        setSession(null);
        return;
      }
      const payload = (await response.json()) as Partial<IdentitySession>;
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
      setSession(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onVis = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVis);
    const timer = window.setInterval(() => void refresh(), 4000);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.clearInterval(timer);
    };
  }, [refresh]);

  return session;
}
