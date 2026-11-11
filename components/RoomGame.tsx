"use client";

import { useEffect, useRef, useState } from "react";
import { admitComposedChat, type ChatMessage } from "@/lib/chat";
import { canPlayRoomGame, composeRoomGame, roomGames, type RoomGameAction } from "@/lib/room-game";
import { isPresenceLive, shortPresenceAddress, type PresenceEntry } from "@/lib/presence";
import { useSeeAcl } from "./SeeAclProvider";
import { objectOwner, useIdentitySession } from "./useIdentitySession";
import { btnPrimary, field } from "@/lib/brand-ui";

export function RoomGame({ roomId, messages, presence, onPublicGraph, seedWsUp, onComposed }: {
  roomId: string; messages: ChatMessage[]; presence: PresenceEntry[]; onPublicGraph: boolean; seedWsUp: boolean;
  onComposed: (message: ChatMessage, putOnGun: boolean) => void;
}) {
  const session = useIdentitySession(), see = useSeeAcl();
  const actor = session ? objectOwner(session) : null;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const current = useRef({ actor, roomId, see, onPublicGraph });
  current.current = { actor, roomId, see, onPublicGraph };
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => { const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 10_000); return () => clearInterval(timer); }, []);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const games = roomGames(messages, roomId), game = games.find(row => row.id === selected) ?? games[0];
  const connected = (address: string | null) => !!address && presence.some(row => row.room === roomId && row.address === address && isPresenceLive(row, now));
  const turn = game && (game.turn === "X" ? game.x : game.o);
  const canPlay = !!actor && !!see?.acl && onPublicGraph && !busy && canPlayRoomGame(see.acl, roomId, actor, now);
  async function send(action: RoomGameAction) {
    if (!actor || !see?.acl || !onPublicGraph || busy || !canPlayRoomGame(see.acl, roomId, actor, Math.floor(Date.now() / 1000))) return;
    setBusy(true); setNotice("");
    try {
      const message = composeRoomGame(roomId, actor, action);
      if (!message || "denied" in admitComposedChat(see.acl, message, actor)) { setNotice("Room access is required to play."); return; }
      await see.persist();
      if (!mounted.current || current.current.actor !== actor || current.current.roomId !== roomId || current.current.see !== see || !current.current.onPublicGraph ||
          !canPlayRoomGame(see.acl, roomId, actor, Math.floor(Date.now() / 1000)) || "denied" in admitComposedChat(see.acl, message, actor)) return;
      onComposed(message, true);
      if (action[0] === "start") setSelected(message.id);
    } catch { setNotice("Could not send that move. Try again."); }
    finally { setBusy(false); }
  }
  return <section className="mt-4 border border-rule bg-ground p-3" aria-label="Room game">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-sm font-semibold text-ink">Tic-tac-toe</h3>
      <button type="button" className={btnPrimary} disabled={!canPlay} onClick={() => void send(["start"])}>
        {game ? "New game" : "Start game"}
      </button>
    </div>
    {!actor ? <p className="mt-2 text-xs text-ink-muted">Sign in to play.</p> : !onPublicGraph ?
      <p className="mt-2 text-xs text-ink-muted">Share this room to play together.</p> : null}
    {!seedWsUp ? <p className="mt-2 text-xs text-ink-muted">Moves may wait for another peer to connect.</p> : null}
    {games.length > 1 ? <label className="mt-2 block text-xs text-ink-muted">Game
      <select className={`ml-2 ${field}`} value={game.id} onChange={event => setSelected(event.target.value)}>
        {games.map((row,index) => <option key={row.id} value={row.id}>{shortPresenceAddress(row.x)} · {index === 0 ? "latest" : `game ${games.length-index}`}</option>)}
      </select>
    </label> : null}
    {game ? <>
      <p className="mt-2 text-xs text-ink-muted">X: {shortPresenceAddress(game.x)}{connected(game.x) ? " · here" : " · away"}
        {game.o ? ` / O: ${shortPresenceAddress(game.o)}${connected(game.o) ? " · here" : " · away"}` : " / O: open seat"}</p>
      <p className="mt-2 text-sm text-ink" role="status">{game.outcome ? (game.outcome === "draw" ? "Draw." : `${game.outcome} wins!`) :
        !game.o ? "Waiting for a second player." : actor === turn ? `Your turn (${game.turn}).` : `${game.turn} to move.`}</p>
      {!game.o && actor !== game.x ? <button type="button" className={`mt-2 ${btnPrimary}`} disabled={!canPlay}
        onClick={() => void send(["join",game.id,game.head])}>Join as O</button> : null}
      <div className="mt-3 grid w-48 grid-cols-3 gap-1" aria-label="Tic-tac-toe board">
        {game.board.map((mark,index) => <button key={index} type="button" aria-label={`Square ${index+1}: ${mark ?? "empty"}`}
          className="h-16 border border-rule bg-ground text-xl font-semibold text-ink disabled:cursor-default"
          disabled={!canPlay || !game.o || !!game.outcome || actor !== turn || mark !== null}
          onClick={() => void send(["move",game.id,game.head,index])}>{mark ?? "·"}</button>)}
      </div>
    </> : <p className="mt-2 text-xs text-ink-muted">Two players, one room. Invite someone here to join.</p>}
    {notice ? <p className="mt-2 text-xs text-ink-muted" role="status">{notice}</p> : null}
  </section>;
}
