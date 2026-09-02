"use client";

import { useCallback, useEffect, useState } from "react";

export type IdentitySession = {
  address: string;
  chainId: number;
};

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
        setSession({
          address: payload.address,
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
