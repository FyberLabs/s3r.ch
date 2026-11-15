/** Transport controller only. Admission and authenticated signaling are owner contracts.
 * A TURN allocation never grants permission to join a room.
 */
export type MeetingPath = "unknown" | "direct" | "relayed";
export type MeetingTransportState = {
  connection: RTCPeerConnectionState;
  path: MeetingPath;
};

/** Read only the selected transport pairs, never an arbitrary successful probe. */
export function selectedMeetingPath(stats: RTCStatsReport): MeetingPath {
  const paths: MeetingPath[] = [];
  stats.forEach((transport) => {
    if (transport.type !== "transport") return;
    const pair = stats.get(transport.selectedCandidatePairId);
    if (!pair || pair.type !== "candidate-pair" || pair.state !== "succeeded") {
      paths.push("unknown");
      return;
    }
    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    const known = (type: unknown) => ["host", "srflx", "prflx", "relay"].includes(String(type));
    if (local?.type !== "local-candidate" || remote?.type !== "remote-candidate" ||
        !known(local.candidateType) || !known(remote.candidateType)) {
      paths.push("unknown");
    } else {
      paths.push(local.candidateType === "relay" || remote.candidateType === "relay" ? "relayed" : "direct");
    }
  });
  if (!paths.length || paths.includes("unknown")) return "unknown";
  return paths.includes("relayed") ? "relayed" : "direct";
}

export type MeetingAuthority = {
  /** Both peers' room admission and identity binding must still be current. */
  current: () => boolean;
  /** Absolute deadline supplied by admission, never extended by this controller. */
  expiresAt: number;
  subscribe: (revoke: () => void) => () => void;
};

/** Owns one peer connection and its dedicated local media tracks.
 * The caller must establish authenticated signaling separately. No public join
 * surface should construct this controller until that contract is available.
 */
export function controlMeetingTransport(input: {
  peer: RTCPeerConnection;
  tracks: readonly MediaStreamTrack[];
  authority: MeetingAuthority;
  changed: (state: MeetingTransportState) => void;
  now?: () => number;
}) {
  const now = input.now ?? Date.now;
  const { peer, authority } = input;
  const tracks = [...input.tracks];
  const expiresAt = authority.expiresAt;
  let lastTime = now();
  let closed = false;
  let generation = 0;
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const allowed = () => {
    try {
      const time = now();
      const valid = Number.isFinite(time) && time >= lastTime && Number.isFinite(expiresAt) && time < expiresAt;
      lastTime = time;
      return valid && authority.current();
    }
    catch { return false; }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    generation++;
    clearTimeout(timer);
    peer.removeEventListener("connectionstatechange", onChange);
    try { unsubscribe?.(); } catch { /* Cleanup must still stop local capture. */ }
    try { peer.close(); } catch { /* A failed close must not retain local capture. */ }
    for (const track of tracks) {
      try { track.stop(); } catch { /* Stop every owned track. */ }
    }
    input.changed({ connection: "closed", path: "unknown" });
  };
  const refresh = async () => {
    if (closed) return;
    if (!allowed()) { close(); return; }
    const revision = ++generation;
    const connection = peer.connectionState;
    if (connection === "closed") { close(); return; }
    input.changed({ connection, path: "unknown" });
    if (connection !== "connected" || closed) return;
    let path: MeetingPath = "unknown";
    try { path = selectedMeetingPath(await peer.getStats()); } catch { /* No guessed path. */ }
    if (closed || revision !== generation) return;
    if (!allowed()) { close(); return; }
    if (peer.connectionState !== "connected") return;
    input.changed({ connection: "connected", path });
  };
  function onChange() { void refresh(); }
  peer.addEventListener("connectionstatechange", onChange);
  if (!allowed()) close();
  else {
    // Re-check wall time on bounded ticks, including after suspended tabs resume.
    const tick = () => {
      if (closed) return;
      void refresh();
      if (!closed) timer = setTimeout(tick, Math.min(1000, Math.max(1, expiresAt - now())));
    };
    try {
      unsubscribe = authority.subscribe(close);
      if (closed) unsubscribe(); // subscribe may synchronously report revocation.
      else tick();
    } catch { close(); }
  }
  return { refresh, close };
}
