"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listHeldConfirmProofs,
  lookupsFromConfirmProofs,
  putHeldConfirmProof,
  type HeldConfirmProof,
} from "@/lib/identity/confirm-proof";
import type { HeldLookupState } from "@/lib/identity/held-claims";

export type HeldConfirmsState = {
  ready: boolean;
  proofs: HeldConfirmProof[];
  lookups: Pick<HeldLookupState, "email" | "phone" | "kyc">;
  putProof: (proof: HeldConfirmProof) => Promise<void>;
};

/**
 * After SIWE, hydrate private confirm proofs. Lookups stay pending
 * until IndexedDB settles so assembleMineUser does not drop them.
 */
export function useHeldConfirms(address: string | null): HeldConfirmsState {
  const [proofs, setProofs] = useState<HeldConfirmProof[] | undefined>(
    address ? undefined : [],
  );

  useEffect(() => {
    if (!address) {
      setProofs([]);
      return;
    }
    let cancelled = false;
    setProofs(undefined);
    void listHeldConfirmProofs(address)
      .then((rows) => {
        if (!cancelled) setProofs(rows);
      })
      .catch(() => {
        if (!cancelled) setProofs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [address]);

  const putProof = useCallback(
    async (proof: HeldConfirmProof) => {
      await putHeldConfirmProof(proof);
      setProofs((current) => {
        const next = (current ?? []).filter((row) => row.kind !== proof.kind);
        next.push(proof);
        return next;
      });
    },
    [],
  );

  const lookups = useMemo(() => {
    if (proofs === undefined) {
      return {
        email: undefined,
        phone: undefined,
        kyc: undefined,
      };
    }
    return lookupsFromConfirmProofs(proofs);
  }, [proofs]);

  return {
    ready: proofs !== undefined,
    proofs: proofs ?? [],
    lookups,
    putProof,
  };
}
