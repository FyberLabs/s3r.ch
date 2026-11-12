"use client";
import { useLayoutEffect, useState } from "react";
import { LiveSquadForum } from "./LiveSquadForum";
import { readSingleUnlockedIdentity, subscribeUnlockedMeshPair } from "@/lib/identity/unlocked-mesh";
import type { SeaPair } from "@/lib/identity/sea";
import type { publicSquadPilotConfig } from "@/lib/squad-pilot-config";

type Props = ReturnType<typeof publicSquadPilotConfig>;
export function SquadPilot(props: Props) {
  const [pair, setPair] = useState<SeaPair | null>(null);
  useLayoutEffect(() => {
    const changed = () => setPair(readSingleUnlockedIdentity()?.pair ?? null);
    const stop = subscribeUnlockedMeshPair(changed);
    changed();
    return stop;
  }, []);
  // Keep one connection across key switches so cookie operations stay serialized.
  return <LiveSquadForum {...props} pair={pair} />;
}
