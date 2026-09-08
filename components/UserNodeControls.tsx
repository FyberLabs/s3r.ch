"use client";

import { useEffect, useMemo, useState } from "react";
import { useGunPeer } from "@/components/GunPeerProvider";
import { useSeeAcl } from "@/components/SeeAclProvider";
import { btnSecondary } from "@/lib/brand-ui";
import {
  admitComposedUser,
  claimIsShared,
  composeUser,
  fromGunUserNode,
  isWalletClaimId,
  namedHeldIndicators,
  prepareShareClaimIntoMesh,
  prepareShareUserIntoMesh,
} from "@/lib/users";

export const USER_SHARE_COPY =
  "Held claims stay Mine until you share. A see-grant is not this. Publish is one-way here.";

type Props = {
  address: string;
  ens?: string | null;
  unstoppable?: string | null;
  farcaster?: string | null;
  lens?: string | null;
  rss3?: string | null;
};

export function UserNodeControls({
  address,
  ens,
  unstoppable,
  farcaster,
  lens,
  rss3,
}: Props) {
  const see = useSeeAcl();
  const peer = useGunPeer();
  const [confirmUser, setConfirmUser] = useState(false);
  const [confirmClaimId, setConfirmClaimId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [published, setPublished] = useState(false);
  const [sharedIndicators, setSharedIndicators] = useState<string[]>([]);

  const indicators = useMemo(
    () => namedHeldIndicators({ ens, unstoppable, farcaster, lens, rss3 }),
    [ens, unstoppable, farcaster, lens, rss3],
  );

  const overlay = useMemo(
    () => composeUser({ address, indicators }),
    [address, indicators],
  );

  useEffect(() => {
    setPublished(false);
    setSharedIndicators([]);
    setConfirmUser(false);
    setConfirmClaimId(null);
    setMessage(null);
  }, [address]);

  useEffect(() => {
    if (!see?.ready || !overlay) return;
    const admitted = admitComposedUser(see.acl, overlay, address);
    if ("denied" in admitted) return;
    void see.persist();
  }, [address, overlay, see]);

  useEffect(() => {
    const gun = peer?.gun;
    if (!gun || !address) return;
    let cancelled = false;
    const listener = gun
      .get("s3rch")
      .get("users")
      .get(address)
      .on((data: unknown) => {
        const user = fromGunUserNode(
          data as Parameters<typeof fromGunUserNode>[0],
        );
        if (!user || cancelled) return;
        setPublished(true);
        setSharedIndicators(user.indicators);
      });
    return () => {
      cancelled = true;
      listener?.off?.();
    };
  }, [address, peer?.gun]);

  async function shareUser() {
    setMessage(null);
    if (!see?.acl || !overlay) {
      setMessage("Could not share this user node.");
      return;
    }
    if (!confirmUser) {
      setConfirmUser(true);
      return;
    }
    const prepared = prepareShareUserIntoMesh(
      see.acl,
      overlay,
      address,
      sharedIndicators,
    );
    if ("denied" in prepared) {
      setMessage("Could not admit this user node.");
      setConfirmUser(false);
      return;
    }
    const gun = peer?.gun;
    if (!gun) {
      setMessage("Gun is not open yet.");
      return;
    }
    gun.get("s3rch").get("users").get(prepared.key).put(prepared.node);
    setPublished(true);
    setConfirmUser(false);
    setMessage(
      "Published this user node to the public graph. Claims stay Mine until you share those claims. One-way here.",
    );
    await see.persist();
  }

  async function shareClaim(claimId: string) {
    setMessage(null);
    if (!see?.acl || !overlay) {
      setMessage("Could not share this claim.");
      return;
    }
    if (confirmClaimId !== claimId) {
      setConfirmClaimId(claimId);
      return;
    }
    const prepared = prepareShareClaimIntoMesh(
      see.acl,
      overlay,
      address,
      claimId,
      sharedIndicators,
    );
    if ("denied" in prepared) {
      setMessage("Could not admit this claim.");
      setConfirmClaimId(null);
      return;
    }
    const gun = peer?.gun;
    if (!gun) {
      setMessage("Gun is not open yet.");
      return;
    }
    gun.get("s3rch").get("users").get(prepared.key).put(prepared.node);
    setPublished(true);
    setSharedIndicators(
      isWalletClaimId(claimId, address)
        ? sharedIndicators
        : [...sharedIndicators, claimId],
    );
    setConfirmClaimId(null);
    setMessage(
      "Published this claim on your user node. Publish is one-way here.",
    );
    await see.persist();
  }

  if (!overlay) return null;

  return (
    <div className="mt-4 border-t border-rule pt-4">
      <p className="text-xs text-ink-muted">{USER_SHARE_COPY}</p>
      <div className="mt-3">
        {published ? (
          <p className="text-xs text-ink-muted">
            User node is on the public graph. Claims stay Mine until you
            share those claims. Publish is one-way here.
          </p>
        ) : (
          <>
            <p className="text-xs text-ink-muted">
              Publish user node puts your wallet on `s3rch/users`. It does
              not dump held claims. A see-grant is not this.
            </p>
            <button
              type="button"
              onClick={() => void shareUser()}
              className={`mt-2 ${btnSecondary}`}
            >
              {confirmUser ? "Confirm publish" : "Publish user node"}
            </button>
          </>
        )}
      </div>
      {indicators.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {indicators.map((claimId) => {
            const shared = claimIsShared(claimId, sharedIndicators);
            return (
              <li
                key={claimId}
                className="flex flex-wrap items-center gap-2 text-xs text-ink-muted"
              >
                <span>{claimId}</span>
                {shared ? (
                  <span>On the public graph.</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => void shareClaim(claimId)}
                    className={btnSecondary}
                  >
                    {confirmClaimId === claimId
                      ? "Confirm share"
                      : "Share claim"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      {message ? <p className="mt-3 text-xs text-ink-muted">{message}</p> : null}
    </div>
  );
}
