"use client";
import { useLayoutEffect, useState } from "react";
import { LiveSquadForum } from "./LiveSquadForum";
import { useIdentitySession } from "./useIdentitySession";
import { readUnlockedMeshPair, subscribeUnlockedMeshPair } from "@/lib/identity/unlocked-mesh";
import type { SeaPair } from "@/lib/identity/sea";
import type { publicSquadPilotConfig } from "@/lib/squad-pilot-config";

type Props = ReturnType<typeof publicSquadPilotConfig>;
export function SquadPilot(props: Props) {
  const session = useIdentitySession(), address = session?.address?.trim().toLowerCase() ?? null;
  const [selected, setSelected] = useState<{ address: string; pair: SeaPair | null } | null>(null);
  useLayoutEffect(() => {
    if (!address) { setSelected(null); return; }
    const stop = subscribeUnlockedMeshPair((heard, pair) => { if (heard === address) setSelected({ address, pair }); });
    setSelected({ address, pair: readUnlockedMeshPair(address) });
    return stop;
  }, [address]);
  // Keep one connection across address switches so cookie operations stay
  // serialized. A stale selection cannot survive even the switch render.
  return <LiveSquadForum {...props} pair={selected?.address === address ? selected.pair : null} />;
}
