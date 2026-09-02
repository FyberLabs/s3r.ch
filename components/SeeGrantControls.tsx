"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { IdentitySeeGrant } from "@/lib/feed-types";
import { applySeeGrant, cancelSee } from "@/lib/identity/check";
import {
  grantWindowFromHours,
  heldClaimOptions,
  parseGrantAccessor,
  SEE_GRANT_COPY,
  type HeldClaimOption,
} from "@/lib/identity/held-claims";
import {
  createMemorySeeAcl,
  grantsOwnedBy,
  hydrateSeeAcl,
  persistSeeAcl,
  type MemorySeeAcl,
} from "@/lib/identity/see-acl";
import { useSeeAcl } from "@/components/SeeAclProvider";
import { btnSecondary, field, fieldMono } from "@/lib/brand-ui";

type Props = {
  address: string;
  ens?: string | null;
  unstoppable?: string | null;
  farcaster?: string | null;
  lens?: string | null;
  rss3?: string | null;
};

export function SeeGrantControls({
  address,
  ens,
  unstoppable,
  farcaster,
  lens,
  rss3,
}: Props) {
  const shared = useSeeAcl();
  const [localAcl] = useState<MemorySeeAcl>(() => createMemorySeeAcl());
  const acl = shared?.acl ?? localAcl;
  const [localReady, setLocalReady] = useState(false);
  const ready = shared ? shared.ready : localReady;
  const [grants, setGrants] = useState<IdentitySeeGrant[]>([]);
  const [accessorInput, setAccessorInput] = useState("");
  const [hoursInput, setHoursInput] = useState("24");
  const [claimId, setClaimId] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const claims = useMemo(
    () => heldClaimOptions({ address, ens, unstoppable, farcaster, lens, rss3 }),
    [address, ens, unstoppable, farcaster, lens, rss3],
  );

  const refreshGrants = useCallback(() => {
    setGrants(grantsOwnedBy(acl, address));
  }, [acl, address]);

  useEffect(() => {
    if (shared) return;
    let cancelled = false;
    void hydrateSeeAcl(acl)
      .catch(() => acl)
      .then(() => {
        if (cancelled) return;
        for (const claim of claims) {
          acl.putObject(claim.id, address);
        }
        refreshGrants();
        setLocalReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [acl, address, claims, refreshGrants, shared]);

  useEffect(() => {
    if (!shared?.ready) return;
    for (const claim of claims) {
      acl.putObject(claim.id, address);
    }
    refreshGrants();
  }, [acl, address, claims, refreshGrants, shared]);

  useEffect(() => {
    if (!ready) return;
    for (const claim of claims) {
      acl.putObject(claim.id, address);
    }
    if (shared) {
      void shared.persist();
      return;
    }
    void persistSeeAcl(acl).catch(() => {
      // Private mode / missing IndexedDB — stay in memory.
    });
  }, [acl, address, claims, ready, shared]);

  useEffect(() => {
    if (!claimId && claims[0]) setClaimId(claims[0].id);
    if (claimId && !claims.some((claim) => claim.id === claimId) && claims[0]) {
      setClaimId(claims[0].id);
    }
  }, [claimId, claims]);

  async function persistAndRefresh() {
    refreshGrants();
    if (shared) {
      await shared.persist();
      return;
    }
    try {
      await persistSeeAcl(acl);
    } catch {
      // Dest ACL stays in memory when IndexedDB is unavailable.
    }
  }

  async function onGrant() {
    setMessage(null);
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
    const selected = claims.find((claim) => claim.id === claimId);
    if (!selected) {
      setMessage("Pick a held claim.");
      return;
    }
    setBusy(true);
    try {
      acl.putObject(selected.id, address);
      applySeeGrant(acl, address, {
        claimId: selected.id,
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
    setBusy(true);
    setMessage(null);
    try {
      cancelSee(acl, address, grant.accessor, grant.claimId);
      await persistAndRefresh();
    } finally {
      setBusy(false);
    }
  }

  if (!claims.length) return null;

  return (
    <div className="mt-4 border-t border-rule pt-4">
      <p className="text-xs text-ink-muted">{SEE_GRANT_COPY}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select
          value={claimId}
          onChange={(event) => setClaimId(event.target.value)}
          disabled={busy}
          className={field}
        >
          {claims.map((claim) => (
            <option key={claim.id} value={claim.id}>
              {claimLabel(claim)}
            </option>
          ))}
        </select>
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
        <ul className="mt-3 space-y-2">
          {grants.map((grant) => (
            <li
              key={`${grant.claimId}:${grant.accessor}:${grant.from}:${grant.until}`}
              className="flex flex-wrap items-center gap-2 text-xs text-ink-muted"
            >
              <span>
                {grant.claimId} → {truncateAddress(grant.accessor)} until{" "}
                {formatUntil(grant.until)}
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
      {message ? <p className="mt-3 text-xs text-ink-muted">{message}</p> : null}
    </div>
  );
}

function claimLabel(claim: HeldClaimOption): string {
  return claim.label;
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
