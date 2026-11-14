"use client";

import { isSeaPubkey } from "@/lib/identity/forum-check";
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
  return isSeaPubkey(session.owner) ? session.owner : "";
}

const UNRESOLVED_SESSION = Symbol("unresolved identity session");
const client = new QueryClient();
const key = ["identity-session"] as const;
const changeKey = "s3rch-session-changed";

async function refresh({ signal }: { signal: AbortSignal }) {
  const response = await fetch("/api/identity/session", { cache: "no-store", signal });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error("Identity service unavailable.");
  const payload = await response.json();
  if (!isSeaPubkey(payload.owner) && !payload.address) return null;
  return {
    address: typeof payload.address === "string" ? payload.address : "",
    chainId: typeof payload.chainId === "number" ? payload.chainId : 1,
    owner: isSeaPubkey(payload.owner) ? payload.owner : "",
    expiresAt: typeof payload.expiresAt === "number" ? payload.expiresAt : Date.now() + 60_000,
  };
}

function invalidate() {
  void client.cancelQueries({ queryKey: key });
  client.setQueryData(key, UNRESOLVED_SESSION);
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

  const query = useQuery<Awaited<ReturnType<typeof refresh>> | typeof UNRESOLVED_SESSION>({
    queryKey: key, queryFn: refresh, enabled,
    retry: false, gcTime: 0, staleTime: 0,
    refetchOnWindowFocus: "always",
    refetchInterval: query => {
      if (query.state.status === "error") return 30_000;
      return query.state.data && query.state.data !== UNRESOLVED_SESSION ? Math.max(1000, query.state.data.expiresAt - Date.now()) : false;
    },
  }, client);
  if (!enabled || query.isPending) return undefined;
  const session = query.data;
  if (session === UNRESOLVED_SESSION) return query.isError ? null : undefined;
  return enabled && !query.isError && session && session.expiresAt > Date.now() ? session : null;
}

export function useIdentitySession(enabled = true): IdentitySession | null {
  return useIdentitySessionState(enabled) ?? null;
}
