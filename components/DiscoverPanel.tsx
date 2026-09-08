"use client";

import { useBrand } from "@/components/brand";
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
  const { reader } = useBrand();

  return (
    <div className={`mt-8 ${panel}`}>
      <h2 className="text-sm font-semibold text-ink">Discover</h2>
      {tags.length === 0 ? (
        <p className="mt-3 text-xs text-ink-muted">
          No tags yet.
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
          {reader === "ai" ? (
            <div className="mt-2 overflow-x-auto">
              <table className="brand-table">
                <thead>
                  <tr>
                    <th scope="col">id</th>
                    <th scope="col">source</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((user) => (
                    <tr key={user.id}>
                      <td className="font-data">{user.id}</td>
                      <td className="whitespace-normal">{userProvenanceLine(user)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <ul className="mt-2 space-y-1">
              {users.map((user) => (
                <li key={user.id} className="text-xs text-ink-muted">
                  {userProvenanceLine(user)}
                </li>
              ))}
            </ul>
          )}
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
          ) : reader === "ai" ? (
            <div className="mt-2 overflow-x-auto">
              <table className="brand-table">
                <thead>
                  <tr>
                    <th scope="col">title</th>
                    <th scope="col">owner</th>
                    <th scope="col">tags</th>
                    <th scope="col">open</th>
                  </tr>
                </thead>
                <tbody>
                  {rooms.map((room) => {
                    const open = selectedRoomId === room.id;
                    return (
                      <tr key={room.id}>
                        <td>
                          <button
                            type="button"
                            onClick={() => onOpenRoom(room)}
                            className="text-ink hover:text-signal"
                          >
                            {room.title}
                          </button>
                        </td>
                        <td className="font-data">{shortenOwner(room.owner)}</td>
                        <td className="whitespace-normal">{room.tags.join(",")}</td>
                        <td className="font-data">{open ? "true" : "false"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
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
      ) : null}
    </div>
  );
}
