import type { Metadata } from "next";
import { GunPeerProvider } from "@/components/GunPeerProvider";
import { MeshAclSync } from "@/components/MeshAclSync";
import { SeeAclProvider } from "@/components/SeeAclProvider";
import { SquadForum } from "@/components/SquadForum";

export const metadata: Metadata = {
  title: "Squad forum — s3r.ch",
  description: "One squad board, its chat, and an agent drawer.",
};

export default function SquadForumPage() {
  return (
    <section className="mx-auto max-w-[1400px] px-4 py-6">
      <SeeAclProvider>
        <GunPeerProvider>
          <MeshAclSync />
          <SquadForum />
        </GunPeerProvider>
      </SeeAclProvider>
    </section>
  );
}
