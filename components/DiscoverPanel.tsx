"use client";

import { TagChips } from "@/components/TagChips";
import { btnTabOff, btnTabOn, panel } from "@/lib/brand-ui";
import {
  discoverTagCounts,
  shortenOwner,
  type DiscoverTag,
} from "@/lib/feed-discover";
import type { Room } from "@/lib/rooms";
import { userProvenanceLine, type User } from "@/lib/users";

export function DiscoverPanel({
  tags,
  rooms,
  users = [],
  selected,
  selectedRoomId,
  onChange,
  onOpenRoom,
}: {
  tags: DiscoverTag[];
  rooms: Room[];
  users?: User[];
  selected: string[];
  selectedRoomId: string | null;
  onChange: (next: string[]) => void;
  onOpenRoom: (room: Room) => void;
}) {
  const counts = discoverTagCounts(tags);
  const tagged = selected.length > 0;

  return (
    <div className={`mt-8 ${panel}`}>
      <h2 className="text-sm font-semibold text-ink">Discover</h2>
      <p className="mt-2 text-xs text-ink-muted">
        Tags already on Public (seed + shared rooms) and the live Network
        mesh. Mine overlay is not here. Counts are how many posts and
        shared rooms already carry the tag — not a popularity score.
        Any-match, then recency. Not search. No Popular / Novel.
        Shared user nodes are provenance (truncated address plus
        shared indicators), not a profile list.
      </p>
      {tags.length === 0 ? (
        <p className="mt-3 text-xs text-ink-muted">
          No tags on Public or the live mesh yet. Empty sources stay empty.
        </p>
      ) : (
        <div className="mt-3">
          <TagChips
            tags={tags.map((row) => row.tag)}
            selected={selected}
            onChange={onChange}
            counts={counts}
            heading=""
            flush
          />
        </div>
      )}
      {users.length > 0 ? (
        <div className="mt-4 border-t border-rule pt-3">
          <p className="text-xs font-medium uppercase tracking-wide text-signal">
            Shared users
          </p>
          <ul className="mt-2 space-y-1">
            {users.map((user) => (
              <li key={user.id} className="text-xs text-ink-muted">
                {userProvenanceLine(user)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {tagged ? (
        <div className="mt-4 border-t border-rule pt-3">
          <p className="text-xs font-medium uppercase tracking-wide text-signal">
            Shared rooms
          </p>
          {rooms.length === 0 ? (
            <p className="mt-2 text-xs text-ink-muted">
              No shared rooms for the selected tags.
            </p>
          ) : (
            <ul className="mt-2 space-y-2">
              {rooms.map((room) => {
                const open = selectedRoomId === room.id;
                return (
                  <li key={room.id}>
                    <button
                      type="button"
                      onClick={() => onOpenRoom(room)}
                      className={`w-full text-left ${open ? btnTabOn : btnTabOff}`}
                    >
                      <span className="font-semibold">{room.title}</span>
                      <span
                        className={`mt-1 block text-xs ${
                          open ? "text-on-signal" : "text-ink-muted"
                        }`}
                      >
                        {shortenOwner(room.owner)}
                        {room.tags.length ? ` · ${room.tags.join(" · ")}` : ""}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : (
        <p className="mt-3 text-xs text-ink-muted">
          Select a tag to list matching shared rooms and rank posts. Owner
          lines are provenance, not a profile.
        </p>
      )}
    </div>
  );
}
