"use client";

import { useEffect } from "react";
import { applyGunAclEdge, subscribeMeshAcl } from "@/lib/identity/mesh-acl";
import { useGunPeer } from "@/components/GunPeerProvider";
import { useSeeAcl } from "@/components/SeeAclProvider";

/**
 * Merge MeshSeeGrant rows from the live Gun graph into the lab dest ACL.
 * Privilege-down stays immediate on IndexedDB; this is how peers evaluate
 * mesh Check when the seed / WebRTC graph has the ACL row.
 */
export function MeshAclSync() {
  const see = useSeeAcl();
  const peer = useGunPeer();

  useEffect(() => {
    if (!see?.ready || !see.acl || !see.mesh || !peer?.gun) return;
    const { acl, mesh } = see;
    return subscribeMeshAcl(peer.gun, (edge) => {
      const won = mesh.merge(edge);
      if (won.hamState !== edge.hamState) return;
      applyGunAclEdge(acl, won);
      void see.persist();
    });
  }, [peer?.gun, see, see?.ready]);

  return null;
}
