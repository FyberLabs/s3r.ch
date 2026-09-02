"use client";

import { useState } from "react";
import { splitTags } from "@/lib/feed-types";
import {
  admitComposedRoom,
  composeRoom,
  ROOM_TITLE_MAX,
  type Room,
} from "@/lib/rooms";
import { useSeeAcl } from "@/components/SeeAclProvider";
import { useIdentitySession } from "@/components/useIdentitySession";

export function RoomsList({
  rooms,
  selectedId,
  onSelect,
  canCreate,
  showCreateHint,
  onCreated,
}: {
  rooms: Room[];
  selectedId: string | null;
  onSelect: (room: Room | null) => void;
  canCreate: boolean;
  showCreateHint: boolean;
  onCreated: (room: Room) => void;
}) {
  return (
    <div className="mt-8 rounded-xl border border-brand-100 bg-brand-50/40 p-5">
      <h2 className="text-sm font-semibold text-brand-900">Rooms</h2>
      <p className="mt-2 text-xs text-gray-500">
        Gun threads. Mine until you share the room node. Live chat, presence,
        and WebRTC are later. Room state in this tab is this-tab Gun until
        WS/mesh.
      </p>
      {canCreate ? (
        <NewRoomForm onCreated={onCreated} />
      ) : showCreateHint ? (
        <p className="mt-3 text-xs text-gray-500">
          Sign in with Ethereum to create a room.
        </p>
      ) : null}
      {rooms.length === 0 ? (
        <p className="mt-3 text-xs text-gray-500">
          {canCreate
            ? "No rooms yet. Title a new room to put it on Mine."
            : "No shared rooms on this graph."}
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {rooms.map((room) => {
            const open = selectedId === room.id;
            return (
              <li key={room.id}>
                <button
                  type="button"
                  onClick={() => onSelect(open ? null : room)}
                  className={`w-full rounded-lg border px-3 py-2 text-left text-sm ${
                    open
                      ? "border-brand-700 bg-white text-brand-900"
                      : "border-brand-100 bg-white text-brand-900 hover:border-brand-500"
                  }`}
                >
                  <span className="font-semibold">{room.title}</span>
                  <span className="mt-1 block text-xs text-gray-500">
                    {room.tags.join(" · ")}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function NewRoomForm({ onCreated }: { onCreated: (room: Room) => void }) {
  const see = useSeeAcl();
  const [title, setTitle] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const session = useIdentitySession()?.address ?? null;

  async function submit() {
    setBusy(true);
    setMessage(null);
    try {
      if (!session) {
        setMessage("Sign in with Ethereum to create a room.");
        return;
      }
      const room = composeRoom({
        title,
        address: session,
        tags: splitTags(tagsInput),
      });
      if (!room) {
        setMessage("Give the room a short title.");
        return;
      }
      if (!see?.acl) {
        setMessage("Could not admit this room.");
        return;
      }
      const admitted = admitComposedRoom(see.acl, room, session);
      if ("denied" in admitted) {
        setMessage("Could not admit this room.");
        return;
      }
      onCreated(admitted.room);
      await see.persist();
      setTitle("");
      setTagsInput("");
      setMessage("On Mine. Not public until you share this room.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4">
      <label className="block text-sm text-gray-700">
        New room
        <input
          type="text"
          value={title}
          maxLength={ROOM_TITLE_MAX}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="title"
          className="mt-1 w-full rounded-lg border border-brand-100 bg-white px-3 py-2 text-sm"
        />
      </label>
      <label className="mt-3 block text-sm text-gray-700">
        Tags
        <input
          type="text"
          value={tagsInput}
          onChange={(event) => setTagsInput(event.target.value)}
          placeholder="optional, comma-separated"
          className="mt-1 w-full rounded-lg border border-brand-100 bg-white px-3 py-2 text-sm"
        />
      </label>
      <div className="mt-3">
        <button
          type="button"
          disabled={busy || !title.trim()}
          onClick={() => void submit()}
          className="rounded-lg bg-brand-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
        >
          New room
        </button>
      </div>
      {message ? <p className="mt-3 text-xs text-gray-500">{message}</p> : null}
    </div>
  );
}
