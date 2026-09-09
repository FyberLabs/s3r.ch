"use client";

import { useMemo, useState } from "react";
import type { FeedItem, IdentitySeeGrant } from "@/lib/feed-types";
import {
  GRANT_DELIVERED_COPY,
  GRANT_DELIVERY_WAIT_COPY,
  GRANT_REVOKED_COPY,
  prepareGrantItemDelivery,
  prepareGrantRetract,
  putGrantDelivery,
} from "@/lib/grant-delivery";
import { grantNamesObject, itemSoul } from "@/lib/identity/check";
import { cancelSeeOnMesh, stateSeeGrantOnMesh } from "@/lib/identity/mesh-acl";
import {
  grantWindowFromHours,
  parseGrantAccessor,
} from "@/lib/identity/held-claims";
import { grantsOwnedBy } from "@/lib/identity/see-acl";
import { useGunPeer } from "@/components/GunPeerProvider";
import { useSeeAcl } from "@/components/SeeAclProvider";
import { btnSecondary, field, fieldMono } from "@/lib/brand-ui";

export const POST_SEE_GRANT_COPY =
  "Let another address see this post. Revoke anytime.";

export function PostSeeGrantControls({
  address,
  item,
}: {
  address: string;
  item: FeedItem;
}) {
  const itemId = item.id;
  const see = useSeeAcl();
  const peer = useGunPeer();
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
        grantNamesObject(grant, itemId) || grantNamesObject(grant, itemSoul(itemId)),
    );
  }, [address, itemId, see, tick]);

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
      const grant = {
        claimId: itemId,
        accessor,
        from: window.from,
        until: window.until,
      };
      stateSeeGrantOnMesh(see.acl, see.mesh, address, grant, peer?.gun);
      const prepared = prepareGrantItemDelivery(
        see.acl,
        item,
        address,
        grant,
        Math.floor(Date.now() / 1000),
      );
      if ("denied" in prepared) {
        setMessage("Granted. Needs a public post to receive.");
      } else if (!peer?.gun) {
        setMessage(GRANT_DELIVERY_WAIT_COPY);
      } else {
        putGrantDelivery(peer.gun, prepared);
        setMessage(GRANT_DELIVERED_COPY);
      }
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
      cancelSeeOnMesh(
        see.acl,
        see.mesh,
        address,
        grant.accessor,
        grant.claimId,
        peer?.gun,
      );
      const retract = prepareGrantRetract(
        address,
        grant,
        "item",
        itemId,
        Math.floor(Date.now() / 1000),
      );
      if (!("denied" in retract) && peer?.gun) {
        putGrantDelivery(peer.gun, retract);
      }
      setMessage(GRANT_REVOKED_COPY);
      await persistAndRefresh();
    } finally {
      setBusy(false);
    }
  }

  if (!see?.ready) return null;

  return (
    <div className="mt-3 border-t border-rule pt-3">
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={accessorInput}
          onChange={(event) => setAccessorInput(event.target.value)}
          placeholder="0x… accessor"
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          className={`min-w-[12rem] flex-1 ${fieldMono}`}
        />
        <input
          type="number"
          min={1}
          step={1}
          value={hoursInput}
          onChange={(event) => setHoursInput(event.target.value)}
          disabled={busy}
          aria-label="Hours"
          className={`w-16 ${field}`}
        />
        <span className="text-xs text-ink-muted">hours</span>
        <button
          type="button"
          disabled={busy}
          onClick={() => void onGrant()}
          className={btnSecondary}
        >
          Grant see
        </button>
      </div>
      {grants.length > 0 ? (
        <ul className="mt-2 space-y-2">
          {grants.map((grant) => (
            <li
              key={`${grant.claimId}:${grant.accessor}:${grant.from}:${grant.until}`}
              className="flex flex-wrap items-center gap-2 text-xs text-ink-muted"
            >
              <span>
                see → {truncateAddress(grant.accessor)} until {formatUntil(grant.until)}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void onRevoke(grant)}
                className={btnSecondary}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {message ? <p className="mt-2 text-xs text-ink-muted">{message}</p> : null}
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
