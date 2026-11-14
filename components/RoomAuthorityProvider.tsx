"use client";
import { roomAuthorityDiagnosticsBlock } from "@/lib/room-authority-diagnostics";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useIdentitySession } from "./useIdentitySession";
import { createForumAuthority } from "@/lib/identity/forum-authority";
import { observeUnlockedForumSigner } from "@/lib/identity/browser-forum-signer";
import { createSquadBrowserSource } from "@/lib/squad-browser-source";
import { createHttpForumAuthorityReader } from "@/lib/forum-authority-http";
import { createRoomChatAdmission } from "@/lib/room-chat-admission";
import { admitBrowserRoom } from "@/lib/room-authority-browser";
import type { publicSquadPilotConfig } from "@/lib/squad-pilot-config";
import type { Room } from "@/lib/rooms";

type Config = ReturnType<typeof publicSquadPilotConfig>;
type Controller = ReturnType<typeof controller>;
function controller(config: Config, session: () => string | null) {
  const authority = createForumAuthority(config.config);
  const browser = createSquadBrowserSource(config);
  const read = createHttpForumAuthorityReader({ endpoint: config.authorityEndpoint, squad: config.squad });
  let generation = 0, active = true, pending = new AbortController();
  const signer = observeUnlockedForumSigner(pub => pub === session(), () => {
    generation++; pending.abort(); pending = new AbortController();
  });
  const admission = createRoomChatAdmission({ graph: authority.graph, parent: config.squad.forumId,
    readerKey: session });
  const unsubscribe = browser.source.subscribe((snapshot, at) => {
    if (snapshot) void authority.refresh(snapshot, at); else authority.invalidate();
  });
  browser.activate();
  return { authority, admission, pair: signer.current,
    async admit(room: Room, share: boolean) {
      const pair = signer.current(), epoch = generation;
      if (!active || !pair) return false;
      try {
        const result = await admitBrowserRoom({ item: { id: room.id, author: room.owner, ts: room.ts }, share,
          pair, squad: config.squad, config: config.config, endpoint: "/api/squad/pilot/room", read,
          fetch, signal: pending.signal });
        if (!active || epoch !== generation || signer.current() !== pair) return false;
        const refreshed = await authority.refresh(result.snapshot, result.at);
        return active && epoch === generation && signer.current() === pair && refreshed.ok && !roomAuthorityDiagnosticsBlock(refreshed.diagnostics, result.snapshot, authority.graph);
      } catch { return false; }
    },
    close() { active = false; generation++; pending.abort(); signer.stop(); unsubscribe(); browser.dispose(); authority.invalidate(); admission.reset(); },
  };
}
const Context = createContext<{ current: Controller | null; revision: number }>({ current: null, revision: 0 });
export function RoomAuthorityProvider({ config, children }: { config: Config | null; children: ReactNode }) {
  const session = useIdentitySession(), key = session?.owner ?? null;
  const keyRef = useRef(key); keyRef.current = key;
  const [current, setCurrent] = useState<Controller | null>(null), [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!config || !key) { setCurrent(null); return; }
    const next = controller(config, () => keyRef.current);
    const stop = next.authority.subscribe(() => setRevision(n => n + 1));
    setCurrent(next);
    return () => { stop(); next.close(); };
  }, [config, key]);
  const value = useMemo(() => ({ current, revision }), [current, revision]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export const useRoomAuthority = () => useContext(Context);
