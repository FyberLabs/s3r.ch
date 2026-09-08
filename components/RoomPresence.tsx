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

  useEffect(() => {
    const tick = window.setInterval(() => {
      setNowSeconds(Math.floor(Date.now() / 1000));
    }, 10_000);
    return () => window.clearInterval(tick);
  }, []);

  return (
    <div className={`mt-6 ${panel}`}>
      <h2 className="text-sm font-semibold text-ink">In this room</h2>
      <p className="mt-2 text-xs text-ink-muted">
        Who is in this room now. Presence is this pass; it is not WebRTC.
        Meetings and streams are later. WebRTC is attempted over STUN when
        ICE works; if it fails, seed peer / snapshot like today. STUN is
        not TURN. Trying seed peer; if the socket is down this list can be
        empty or local only. There is no hosted presence server.
        {onPublicGraph
          ? seedWsUp
            ? " This room node is on the public graph. Heartbeats go through the seed peer when the socket is up."
            : " This room node is on the public graph. Snapshot is not a presence list."
          : " This room is Mine. Presence stays on your overlay until you share the room node. Sharing the room does not publish Mine posts inside it."}
      </p>
      {listed.length === 0 ? (
        <p className="mt-3 text-xs text-ink-muted">
          {onPublicGraph
            ? "No one in this room on this graph yet."
            : "No local presence in this room yet."}
        </p>
      ) : (
        <p className="mt-3 text-xs text-ink">
          {listed
            .map((row) =>
              presenceDisplayName(row.address, knownClaims?.[row.address]),
            )
            .join(" · ")}
        </p>
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
        Sign in with Ethereum to announce. Unsigned visitors can see presence
        when this room node is on the public graph. A see-grant is not
        delivery.
      </p>
    );
  }

  return (
    <p className="mt-3 text-xs text-ink-muted">
      Signed-in presence announces while this room is open.
    </p>
  );
}
