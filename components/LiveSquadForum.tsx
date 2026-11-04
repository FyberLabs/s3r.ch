"use client";

import { useLayoutEffect, useState } from "react";
import { SquadForum } from "./SquadForum";
import { ForumAuthorityProvider } from "./ForumAuthorityProvider";
import { createSquadConnection, type SquadConnectionState } from "@/lib/squad-connection";
import { squadView } from "@/lib/squad-view";
import type { SeaPair } from "@/lib/identity/sea";

type Props = Omit<Parameters<typeof createSquadConnection>[0], "fetch" | "onState"> & { pair: SeaPair | null };
/** Client-only provisioned wrapper. The pair must come from the existing local
 * unlock flow, never serialized as a server prop or embedded in deployment config. */
export function LiveSquadForum(props: Props) {
  const view = squadView(props.squad);
  if (!view.live) throw Error("Live Squad required");
  const identity = JSON.stringify([view.key, props.origin, props.sessionBase,
    props.authorityEndpoint, props.assignmentBase, props.config]);
  return <ConnectedSquad key={identity} {...props} />;
}
function ConnectedSquad(props: Props) {
  const [connection, setConnection] = useState<ReturnType<typeof createSquadConnection> | null>(null);
  const [state, setState] = useState<SquadConnectionState>("disconnected");
  useLayoutEffect(() => {
    let active = true;
    const current = createSquadConnection({ squad: props.squad, config: props.config, origin: props.origin, sessionBase: props.sessionBase, authorityEndpoint: props.authorityEndpoint, assignmentBase: props.assignmentBase, onState: value => { if (active) setState(value); } });
    setConnection(current);
    // Construct inside the effect so Strict Mode cleanup never reuses a disposed
    // connection. Parent identity remounts on namespace or policy changes.
    return () => { active = false; current.dispose(); };
  // This mounted instance owns the initial, identity-bound configuration.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useLayoutEffect(() => {
    if (connection) void connection.selectKey(props.pair);
  }, [connection, props.pair]);
  return <ForumAuthorityProvider source={connection?.source}>
    <div className="flex items-center gap-3 p-3" aria-live="polite">
      <span>{state === "connecting" ? "Connecting…" : state === "connected" ? "Session connected" : "Disconnected"}</span>
      <button type="button" disabled={!connection || !props.pair || state === "connecting"}
        onClick={() => { if (connection && props.pair) void connection.selectKey(props.pair); }}>Connect Squad</button>
      <button type="button" disabled={!connection}
        onClick={() => { void connection?.selectKey(null); }}>Disconnect</button>
    </div>
    <SquadForum key={props.pair?.pub ?? "locked"} live={props.squad} />
  </ForumAuthorityProvider>;
}
