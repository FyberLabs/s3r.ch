"use client";

import { useEffect } from "react";
import { QueryClient, useQuery } from "@tanstack/react-query";

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

const client = new QueryClient();
const key = ["identity-session"] as const;
const changeKey = "s3rch-session-changed";

async function refresh({ signal }: { signal: AbortSignal }) {
  const response = await fetch("/api/identity/session", { cache: "no-store", signal });
  if (!response.ok) return null;
  const payload = await response.json();
  if (typeof payload.address !== "string" || !payload.address) return null;
  return {
    address: payload.address as string,
    chainId: typeof payload.chainId === "number" ? payload.chainId : 1,
    owner: typeof payload.owner === "string" && payload.owner ? payload.owner : payload.address as string,
    expiresAt: typeof payload.expiresAt === "number" ? payload.expiresAt : Date.now() + 60_000,
  };
}

function invalidate() {
  void client.cancelQueries({ queryKey: key });
  client.setQueryData(key, null);
  window.dispatchEvent(new Event(changeKey));
  void client.invalidateQueries({ queryKey: key });
}

export function identitySessionChanged() {
  invalidate();
  try {
    localStorage.setItem(changeKey, crypto.randomUUID());
  } catch { /* Storage can be disabled. Visibility also refreshes the session. */ }
}

let consumers = 0;
function onStorage(event: StorageEvent) {
  if (event.key === changeKey) invalidate();
}

export function useIdentitySessionState(enabled = true): IdentitySession | null | undefined {
  useEffect(() => {
    if (!enabled) return;
    if (++consumers === 1) {
      client.mount();
      window.addEventListener("storage", onStorage);
    }
    return () => {
      if (--consumers === 0) {
        window.removeEventListener("storage", onStorage);
        client.unmount();
      }
    };
  }, [enabled]);

  const query = useQuery({
    queryKey: key, queryFn: refresh, enabled,
    retry: false, gcTime: 0, staleTime: Infinity,
    refetchOnWindowFocus: "always",
    refetchInterval: query => query.state.data
      ? Math.max(1000, query.state.data.expiresAt - Date.now())
      : false,
  }, client);
  if (!enabled || query.isPending) return undefined;
  const session = query.data;
  return enabled && !query.isError && session && session.expiresAt > Date.now() ? session : null;
}

export function useIdentitySession(enabled = true): IdentitySession | null {
  return useIdentitySessionState(enabled) ?? null;
}
