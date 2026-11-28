"use client";

import { useState } from "react";
import Link from "next/link";
import { GunPeerProvider } from "@/components/GunPeerProvider";
import { SquadForum } from "@/components/SquadForum";
import { LiveSquadForum } from "@/components/LiveSquadForum";
import { SquadCreatePanel } from "@/components/SquadCreatePanel";
import { ForumAuthorityProvider } from "@/components/ForumAuthorityProvider";
import { objectOwner, useIdentitySession } from "@/components/useIdentitySession";
import { observeUnlockedForumSigner } from "@/lib/identity/browser-forum-signer";
import { squadForumClientConfig } from "@/lib/squad-forum-client-config";
import type { LiveSquadSpec } from "@/lib/squad-view";
import type { SeaPair } from "@/lib/identity/sea";
import { useEffect } from "react";

export default function SquadForumPage() {
  const session = useIdentitySession();
  const [squad, setSquad] = useState<LiveSquadSpec | null>(null);
  const [origin, setOrigin] = useState<string | null>(null);
  const [pair, setPair] = useState<SeaPair | null>(null);
  useEffect(() => {
    const owner = session ? objectOwner(session) : "";
    const signer = observeUnlockedForumSigner(pub => !!owner && pub === owner, () => setPair(signer.current()));
    setPair(signer.current());
    return () => signer.stop();
  }, [session]);
  useEffect(() => {
    if (!session) return;
    void fetch("/api/squad/client-config", { credentials: "same-origin" })
      .then(response => response.ok ? response.json() : null)
      .then(body => { if (body?.config?.origin) setOrigin(body.config.origin); });
  }, [session]);

  const client = origin ? squadForumClientConfig(origin) : null;

  return (
    <ForumAuthorityProvider>
    <section className="mx-auto max-w-[1400px] px-4 py-6">
      <p className="mb-4 text-sm text-ink-muted">
        Squads (coming soon) include SEA-owned forums you can create when ACL mode is enabled. Plane delivery and agent enrollment are not available yet.{" "}
        <Link href="/features/groups" className="font-semibold text-ink hover:text-signal">
          How groups work
        </Link>
      </p>
      <GunPeerProvider>
        <SquadCreatePanel pair={pair} onCreated={setSquad} />
        {client && squad && pair
          ? <LiveSquadForum
              pair={pair}
              squad={squad}
              origin={client.origin}
              sessionBase={client.sessionBase}
              authorityEndpoint={client.authorityEndpoint}
              statementEndpoint={client.statementEndpoint}
              config={client.config}
            />
          : <SquadForum live={undefined} />}
      </GunPeerProvider>
    </section>
    </ForumAuthorityProvider>
  );
}