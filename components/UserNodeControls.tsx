"use client";

import { useEffect, useMemo, useState } from "react";
import { useGunPeer } from "@/components/GunPeerProvider";
import { useSeeAcl } from "@/components/SeeAclProvider";
import { btnSecondary } from "@/lib/brand-ui";
import {
  CLAIM_UNSHARE_COPY,
  USER_UNSHARE_COPY,
  isUnsharePut,
} from "@/lib/unshare";
import { claimLabelFromId } from "@/lib/identity/held-claims";
import { putMineUserOverlay } from "@/lib/identity/user-overlay";
import {
  claimIsShared,
  fromGunUserNode,
  isWalletClaimId,
  prepareShareClaimIntoMesh,
  prepareShareUserIntoMesh,
  prepareUnshareClaimFromMesh,
  prepareUnshareUserFromMesh,
  registerMineUserOverlay,
  type User,
} from "@/lib/users";

export const USER_SHARE_COPY =
  "Share your public name. Claims stay private until you share them.";

type Props = {
  address: string;
  overlay: User | null;
  ready?: boolean;
};

export function UserNodeControls({
  address,
  overlay,
  ready = true,
}: Props) {
  const see = useSeeAcl();
  const peer = useGunPeer();
  const [confirmUser, setConfirmUser] = useState(false);
  const [confirmUnshareUser, setConfirmUnshareUser] = useState(false);
  const [confirmClaimId, setConfirmClaimId] = useState<string | null>(null);
  const [confirmUnshareClaimId, setConfirmUnshareClaimId] = useState<
    string | null
  >(null);
  const [message, setMessage] = useState<string | null>(null);
  const [published, setPublished] = useState(false);
  const [sharedIndicators, setSharedIndicators] = useState<string[]>([]);

  const indicators = useMemo(
    () => overlay?.indicators ?? [],
    [overlay],
  );

  useEffect(() => {
    setPublished(false);
    setSharedIndicators([]);
    setConfirmUser(false);
    setConfirmUnshareUser(false);
    setConfirmClaimId(null);
    setConfirmUnshareClaimId(null);
    setMessage(null);
  }, [address]);

  useEffect(() => {
    if (!see?.ready || !ready || !overlay) return;
    const admitted = registerMineUserOverlay(see.acl, overlay, address);
    if ("denied" in admitted) return;
    void putMineUserOverlay(overlay).catch(() => {
      // Private mode / missing IndexedDB — dest ACL still has the link.
    });
    void see.persist();
  }, [address, overlay, ready, see]);

  useEffect(() => {
    const gun = peer?.gun;
    if (!gun || !address) return;
    let cancelled = false;
    const listener = gun
      .get("s3rch")
      .get("users")
      .get(address)
      .on((data: unknown) => {
        if (cancelled) return;
        if (isUnsharePut(data)) {
          setPublished(false);
          setSharedIndicators([]);
          return;
        }
        const user = fromGunUserNode(
          data as Parameters<typeof fromGunUserNode>[0],
        );
        if (!user) return;
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
      setMessage("Could not share.");
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
      setMessage("Could not publish.");
      setConfirmUser(false);
      return;
    }
    const gun = peer?.gun;
    if (!gun) {
      setMessage("Not ready yet.");
      return;
    }
    gun.get("s3rch").get("users").get(prepared.key).put(prepared.node);
    setPublished(true);
    setConfirmUser(false);
    setMessage("Listed. Claims stay private until you share them.");
    await see.persist();
  }

  async function unshareUser() {
    setMessage(null);
    if (!see?.acl || !overlay) {
      setMessage("Could not unshare.");
      return;
    }
    if (!confirmUnshareUser) {
      setConfirmUnshareUser(true);
      setConfirmUser(false);
      return;
    }
    const prepared = prepareUnshareUserFromMesh(see.acl, overlay, address);
    if ("denied" in prepared) {
      setMessage("Could not unshare.");
      setConfirmUnshareUser(false);
      return;
    }
    const gun = peer?.gun;
    if (!gun) {
      setMessage("Not ready yet.");
      return;
    }
    gun.get("s3rch").get("users").get(prepared.key).put(prepared.tombstone);
    setPublished(false);
    setSharedIndicators([]);
    setConfirmUnshareUser(false);
    setMessage(USER_UNSHARE_COPY);
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
      setMessage("Could not share.");
      setConfirmClaimId(null);
      return;
    }
    const gun = peer?.gun;
    if (!gun) {
      setMessage("Not ready yet.");
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
    setMessage("Shared.");
    await see.persist();
  }

  async function unshareClaim(claimId: string) {
    setMessage(null);
    if (!see?.acl || !overlay) {
      setMessage("Could not unshare this claim.");
      return;
    }
    if (confirmUnshareClaimId !== claimId) {
      setConfirmUnshareClaimId(claimId);
      setConfirmClaimId(null);
      return;
    }
    const prepared = prepareUnshareClaimFromMesh(
      see.acl,
      overlay,
      address,
      claimId,
      sharedIndicators,
    );
    if ("denied" in prepared) {
      setMessage("Could not unshare this claim.");
      setConfirmUnshareClaimId(null);
      return;
    }
    const gun = peer?.gun;
    if (!gun) {
      setMessage("Not ready yet.");
      return;
    }
    if ("tombstone" in prepared) {
      gun.get("s3rch").get("users").get(prepared.key).put(prepared.tombstone);
      setPublished(false);
      setSharedIndicators([]);
    } else {
      gun.get("s3rch").get("users").get(prepared.key).put(prepared.node);
      setSharedIndicators((prev) =>
        prev.filter((row) => row.toLowerCase() !== claimId.toLowerCase()),
      );
    }
    setConfirmUnshareClaimId(null);
    setMessage(CLAIM_UNSHARE_COPY);
    await see.persist();
  }

  if (!overlay) return null;

  return (
    <div className="mt-4 border-t border-rule pt-4">
      <div className="mt-3">
        {published ? (
          <button
            type="button"
            onClick={() => void unshareUser()}
            className={btnSecondary}
          >
            {confirmUnshareUser ? "Confirm unshare" : "Unshare"}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void shareUser()}
            className={btnSecondary}
          >
            {confirmUser ? "Confirm publish" : "Publish name"}
          </button>
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
                <span>{claimLabelFromId(claimId)}</span>
                {shared ? (
                  <>
                    <span>Public.</span>
                    <button
                      type="button"
                      onClick={() => void unshareClaim(claimId)}
                      className={btnSecondary}
                    >
                      {confirmUnshareClaimId === claimId
                        ? "Confirm unshare"
                        : "Unshare"}
                    </button>
                  </>
                ) : (
                  <>
                    <span>Held.</span>
                    <button
                      type="button"
                      onClick={() => void shareClaim(claimId)}
                      className={btnSecondary}
                    >
                      {confirmClaimId === claimId
                        ? "Confirm share"
                        : "Share"}
                    </button>
                  </>
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
