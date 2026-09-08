"use client";

import { useEffect, useState } from "react";
import {
  admitComposedPresence,
  composePresence,
  composePresenceLeave,
  livePresence,
  presenceDisplayName,
  PRESENCE_HEARTBEAT_MS,
  type PresenceEntry,
} from "@/lib/presence";
import { useBrand } from "@/components/brand";
import { useSeeAcl } from "@/components/SeeAclProvider";
import { useIdentitySession } from "@/components/useIdentitySession";
import { panel } from "@/lib/brand-ui";

export function RoomPresence({
  roomId,
  entries,
  onPublicGraph,
  seedWsUp,
  knownClaims,
  onAnnounced,
}: {
  roomId: string;
  entries: PresenceEntry[];
  onPublicGraph: boolean;
  seedWsUp: boolean;
  /** Local-only labels (held claims already on /feed). Never written to Gun. */
  knownClaims?: Readonly<Record<string, string>>;
  onAnnounced: (entry: PresenceEntry, putOnGun: boolean) => void;
}) {
  const [nowSeconds, setNowSeconds] = useState(() =>
    Math.floor(Date.now() / 1000),
  );
  const listed = livePresence(entries, nowSeconds);
  const { reader } = useBrand();

  useEffect(() => {
    const tick = window.setInterval(() => {
      setNowSeconds(Math.floor(Date.now() / 1000));
    }, 10_000);
    return () => window.clearInterval(tick);
  }, []);

  return (
    <div className={`mt-6 ${panel}`}>
      <h2 className="text-sm font-semibold text-ink">In this room</h2>
      {listed.length === 0 ? (
        <p className="mt-3 text-xs text-ink-muted">
          No one here yet.
        </p>
      ) : (
        reader === "ai" ? (
          <div className="mt-3 overflow-x-auto">
            <table className="brand-table">
              <thead>
                <tr>
                  <th scope="col">address</th>
                  <th scope="col">label</th>
                  <th scope="col">ts</th>
                </tr>
              </thead>
              <tbody>
                {listed.map((row) => (
                  <tr key={row.address}>
                    <td className="font-data">{row.address}</td>
                    <td>
                      {presenceDisplayName(row.address, knownClaims?.[row.address])}
                    </td>
                    <td className="font-data">
                      {new Date(row.ts * 1000).toISOString().replace(".000Z", "Z")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-3 text-xs text-ink">
            {listed
              .map((row) =>
                presenceDisplayName(row.address, knownClaims?.[row.address]),
              )
              .join(" · ")}
          </p>
        )
      )}
      <PresenceAnnounce
        roomId={roomId}
        onPublicGraph={onPublicGraph}
        onAnnounced={onAnnounced}
      />
    </div>
  );
}

function PresenceAnnounce({
  roomId,
  onPublicGraph,
  onAnnounced,
}: {
  roomId: string;
  onPublicGraph: boolean;
  onAnnounced: (entry: PresenceEntry, putOnGun: boolean) => void;
}) {
  const session = useIdentitySession();
  const see = useSeeAcl();
  const sessionAddress = session?.address ?? null;

  useEffect(() => {
    if (!sessionAddress || !see?.acl) return;
    const acl = see.acl;
    const persist = see.persist;
    let cancelled = false;
    let interval: number | undefined;
    let persisted = false;

    const beat = () => {
      const next = composePresence({
        roomId,
        address: sessionAddress,
      });
      if (!next || cancelled) return;
      const admitted = admitComposedPresence(acl, next, sessionAddress);
      if ("denied" in admitted) return;
      onAnnounced(admitted.entry, onPublicGraph);
      if (!persisted) {
        persisted = true;
        void persist();
      }
    };

    const leave = () => {
      const next = composePresenceLeave({
        roomId,
        address: sessionAddress,
      });
      if (!next) return;
      const admitted = admitComposedPresence(acl, next, sessionAddress);
      if ("denied" in admitted) return;
      onAnnounced(admitted.entry, onPublicGraph);
    };

    const onVis = () => {
      if (document.visibilityState === "hidden") {
        if (interval !== undefined) window.clearInterval(interval);
        interval = undefined;
        leave();
        return;
      }
      beat();
      if (interval !== undefined) window.clearInterval(interval);
      interval = window.setInterval(beat, PRESENCE_HEARTBEAT_MS);
    };

    if (document.visibilityState !== "hidden") {
      beat();
      interval = window.setInterval(beat, PRESENCE_HEARTBEAT_MS);
    }
    document.addEventListener("visibilitychange", onVis);

    return () => {
      cancelled = true;
      if (interval !== undefined) window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVis);
      leave();
    };
  }, [sessionAddress, see, roomId, onPublicGraph, onAnnounced]);

  if (!session) {
    return (
      <p className="mt-3 text-xs text-ink-muted">
        Sign in to appear.
      </p>
    );
  }

  return null;
}
