"use client";

import { useMemo, useState } from "react";
import type { IdentitySeeGrant } from "@/lib/feed-types";
import { applySeeGrant, cancelSee, grantNamesObject, roomSoul } from "@/lib/identity/check";
import {
  grantWindowFromHours,
  parseGrantAccessor,
} from "@/lib/identity/held-claims";
import { grantsOwnedBy } from "@/lib/identity/see-acl";
import { useSeeAcl } from "@/components/SeeAclProvider";

export const ROOM_SEE_GRANT_COPY =
  "This is a grant, not login, and not share-into-mesh. Grant is not delivery. The accessor may see; they do not receive the room until it is on a graph they can read.";

export function RoomSeeGrantControls({
  address,
  roomId,
}: {
  address: string;
  roomId: string;
}) {
  const see = useSeeAcl();
  const [accessorInput, setAccessorInput] = useState("");
  const [hoursInput, setHoursInput] = useState("24");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  const grants = useMemo(() => {
    void tick;
    if (!see?.acl) return [];
    return grantsOwnedBy(see.acl, address).filter(
      (grant) =>
        grantNamesObject(grant, roomId) || grantNamesObject(grant, roomSoul(roomId)),
    );
  }, [address, roomId, see, tick]);

  async function persistAndRefresh() {
    setTick((n) => n + 1);
    await see?.persist();
  }

  async function onGrant() {
    setMessage(null);
    if (!see?.acl) {
      setMessage("Could not grant see.");
      return;
    }
    const accessor = parseGrantAccessor(accessorInput);
    if (!accessor) {
      setMessage("Enter a checksummed address.");
      return;
    }
    if (accessor.toLowerCase() === address.toLowerCase()) {
      setMessage("Grant see to another address.");
      return;
    }
    const hours = Number(hoursInput);
    const window = grantWindowFromHours(hours);
    if (!window) {
      setMessage("Enter a time window in hours.");
      return;
    }
    setBusy(true);
    try {
      applySeeGrant(see.acl, address, {
        claimId: roomId,
        accessor,
        from: window.from,
        until: window.until,
      });
      setAccessorInput("");
      await persistAndRefresh();
    } finally {
      setBusy(false);
    }
  }

  async function onRevoke(grant: IdentitySeeGrant) {
    if (!see?.acl) return;
    setBusy(true);
    setMessage(null);
    try {
      cancelSee(see.acl, address, grant.accessor, grant.claimId);
      await persistAndRefresh();
    } finally {
      setBusy(false);
    }
  }

  if (!see?.ready) return null;

  return (
    <div className="mt-3 border-t border-brand-100 pt-3">
      <p className="text-xs text-gray-500">{ROOM_SEE_GRANT_COPY}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={accessorInput}
          onChange={(event) => setAccessorInput(event.target.value)}
          placeholder="0x… accessor"
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          className="min-w-[12rem] flex-1 rounded-lg border border-brand-100 bg-white px-3 py-2 font-mono text-xs text-gray-700 disabled:opacity-50"
        />
        <input
          type="number"
          min={1}
          step={1}
          value={hoursInput}
          onChange={(event) => setHoursInput(event.target.value)}
          disabled={busy}
          aria-label="Hours"
          className="w-16 rounded-lg border border-brand-100 bg-white px-3 py-2 text-xs text-gray-700 disabled:opacity-50"
        />
        <span className="text-xs text-gray-500">hours</span>
        <button
          type="button"
          disabled={busy}
          onClick={() => void onGrant()}
          className="rounded-lg border border-brand-700 px-3 py-2 text-xs font-semibold text-brand-800 disabled:opacity-50"
        >
          Grant see
        </button>
      </div>
      {grants.length > 0 ? (
        <ul className="mt-2 space-y-2">
          {grants.map((grant) => (
            <li
              key={`${grant.claimId}:${grant.accessor}:${grant.from}:${grant.until}`}
              className="flex flex-wrap items-center gap-2 text-xs text-gray-500"
            >
              <span>
                see → {truncateAddress(grant.accessor)} until {formatUntil(grant.until)}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void onRevoke(grant)}
                className="rounded-lg border border-brand-700 px-2 py-1 text-xs font-semibold text-brand-800 disabled:opacity-50"
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {message ? <p className="mt-2 text-xs text-gray-500">{message}</p> : null}
    </div>
  );
}

function truncateAddress(address: string): string {
  if (address.length < 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatUntil(until: number): string {
  const ms = until * 1000;
  if (!Number.isFinite(ms) || ms <= 0) return String(until);
  try {
    return new Date(ms).toISOString().slice(0, 16).replace("T", " ") + "Z";
  } catch {
    return String(until);
  }
}
