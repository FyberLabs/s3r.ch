"use client";

import { useEffect, useMemo, useState } from "react";
import type { HeldLookupState } from "@/lib/identity/held-claims";
import { getMineUserOverlay } from "@/lib/identity/user-overlay";
import { assembleMineUser, type User } from "@/lib/users";

export type MineUserOverlayState = {
  overlay: User | null;
  ready: boolean;
};

/**
 * After SIWE, assemble the Mine overlay GunUserNode from settled
 * held-claim lookups plus any previously linked overlay. Waits for
 * local hydrate so a pending lookup does not wipe stored claims.
 */
export function useMineUserOverlay(
  address: string | null,
  lookups: HeldLookupState,
): MineUserOverlayState {
  const [previous, setPrevious] = useState<User | null | undefined>(
    address ? undefined : null,
  );

  useEffect(() => {
    if (!address) {
      setPrevious(null);
      return;
    }
    let cancelled = false;
    setPrevious(undefined);
    void getMineUserOverlay(address)
      .then((row) => {
        if (!cancelled) setPrevious(row);
      })
      .catch(() => {
        if (!cancelled) setPrevious(null);
      });
    return () => {
      cancelled = true;
    };
  }, [address]);

  const overlay = useMemo(() => {
    if (!address || previous === undefined) return null;
    return assembleMineUser({
      address,
      lookups,
      previous,
    });
  }, [address, lookups, previous]);

  return {
    overlay,
    ready: Boolean(address) && previous !== undefined,
  };
}
