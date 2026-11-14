"use client";

import { useRoomAuthority } from "./RoomAuthorityProvider";
import { useLayoutEffect, useRef, useState } from "react";
import { shortenOwner } from "@/lib/feed-discover";
import { splitTags } from "@/lib/feed-types";
import {
  admitComposedRoom,
  composeSignedRoom,
  ROOM_TITLE_MAX,
  type Room,
} from "@/lib/rooms";
import { useBrand } from "@/components/brand";
import { useSeeAcl } from "@/components/SeeAclProvider";
import { objectOwner, useIdentitySession } from "@/components/useIdentitySession";
import { btnPrimary, btnTabOff, btnTabOn, field, panel } from "@/lib/brand-ui";

export function RoomsList({
  rooms,
  selectedId,
  onSelect,
  canCreate,
  showCreateHint,
  emptyHint,
  onCreated,
  showOwner = false,
}: {
  rooms: Room[];
  selectedId: string | null;
  onSelect: (room: Room | null) => void;
  canCreate: boolean;
  showCreateHint: boolean;
  emptyHint?: string;
  onCreated: (room: Room) => void;
  /** Public / Network provenance snippet. Not a user profile. */
  showOwner?: boolean;
}) {
  const { reader } = useBrand();

  return (
    <div className={`mt-8 ${panel}`}>
      <h2 className="text-sm font-semibold text-ink">Rooms</h2>
      {canCreate ? (
        <NewRoomForm onCreated={onCreated} />
      ) : showCreateHint ? (
        <p className="mt-3 text-xs text-ink-muted">
          Sign in to create a room.
        </p>
      ) : null}
      {rooms.length === 0 ? (
        <p className="mt-3 text-xs text-ink-muted">
          {emptyHint
            ? emptyHint
            : canCreate
              ? "No rooms yet. Title a new room to put it on Mine."
              : "No rooms yet."}
        </p>
      ) : (
        reader === "ai" ? (
          <div className="mt-3 overflow-x-auto">
            <table className="brand-table">
              <thead>
                <tr>
                  <th scope="col">title</th>
                  {showOwner ? <th scope="col">owner</th> : null}
                  <th scope="col">tags</th>
                  <th scope="col">open</th>
                </tr>
              </thead>
              <tbody>
                {rooms.map((room) => {
                  const open = selectedId === room.id;
                  return (
                    <tr key={room.id}>
                      <td>
                        <button
                          type="button"
                          onClick={() => onSelect(open ? null : room)}
                          className="text-ink hover:text-signal"
                        >
                          {room.title}
                        </button>
                      </td>
                      {showOwner ? (
                        <td className="font-data">{shortenOwner(room.owner)}</td>
                      ) : null}
                      <td className="whitespace-normal">{room.tags.join(",")}</td>
                      <td className="font-data">{open ? "true" : "false"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <ul className="mt-3 space-y-2">
            {rooms.map((room) => {
              const open = selectedId === room.id;
              return (
                <li key={room.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(open ? null : room)}
                    className={`w-full text-left ${open ? btnTabOn : btnTabOff}`}
                  >
                    <span className="font-semibold">{room.title}</span>
                    <span
                      className={`mt-1 block text-xs ${
                        open ? "text-on-signal" : "text-ink-muted"
                      }`}
                    >
                      {showOwner ? `${shortenOwner(room.owner)} · ` : ""}
                      {room.tags.join(" · ")}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )
      )}
    </div>
  );
}

function NewRoomForm({ onCreated }: { onCreated: (room: Room) => void }) {
  const see = useSeeAcl();
  const { current: roomAuthority } = useRoomAuthority();
  const [title, setTitle] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const identity = useIdentitySession();
  const session = identity ? objectOwner(identity) : null;
  const mounted = useRef(true);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const current = useRef({ session, roomAuthority, see });
  current.current = { session, roomAuthority, see };

  async function submit() {
    setBusy(true);
    setMessage(null);
    try {
      if (!session) {
        setMessage("Sign in to create a room.");
        return;
      }
      const pair = roomAuthority?.pair();
      const principal = pair && roomAuthority?.authority.graph.principalForKey(pair.pub, Math.floor(Date.now() / 1000));
      if (!principal) { setMessage("Room access is unavailable. Sign in with your unlocked identity."); return; }
      const room = composeSignedRoom({
        title,
        address: principal,
        tags: splitTags(tagsInput),
      });
      if (!room) {
        setMessage("Give the room a short title.");
        return;
      }
      if (!see?.acl) {
        setMessage("Could not create this room.");
        return;
      }
      if (!roomAuthority || !await roomAuthority.admit(room, false)) { setMessage("Could not create this room."); return; }
      if (!mounted.current || current.current.session !== session || current.current.roomAuthority !== roomAuthority || current.current.see !== see) return;
      const admitted = admitComposedRoom(see.acl, room, principal);
      if ("denied" in admitted) {
        setMessage("Could not create this room.");
        return;
      }
      onCreated(admitted.room);
      await see.persist();
      setTitle("");
      setTagsInput("");
      setMessage("Saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4">
      <label className="block text-sm text-ink">
        New room
        <input
          type="text"
          value={title}
          maxLength={ROOM_TITLE_MAX}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="title"
          className={`mt-1 w-full ${field}`}
        />
      </label>
      <label className="mt-3 block text-sm text-ink">
        Tags
        <input
          type="text"
          value={tagsInput}
          onChange={(event) => setTagsInput(event.target.value)}
          placeholder="optional, comma-separated"
          className={`mt-1 w-full ${field}`}
        />
      </label>
      <div className="mt-3">
        <button
          type="button"
          disabled={busy || !title.trim()}
          onClick={() => void submit()}
          className={btnPrimary}
        >
          New room
        </button>
      </div>
      {message ? <p className="mt-3 text-xs text-ink-muted">{message}</p> : null}
    </div>
  );
}
