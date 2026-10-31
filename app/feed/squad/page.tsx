import type { Metadata } from "next";
import Link from "next/link";
import { GunPeerProvider } from "@/components/GunPeerProvider";
import { MeshAclSync } from "@/components/MeshAclSync";
import { SeeAclProvider } from "@/components/SeeAclProvider";
import { SquadForum } from "@/components/SquadForum";

export const metadata: Metadata = {
  title: "Squad forum — s3r.ch",
  description: "A squad board for contributors: needs, offers, and chat.",
};

export default function SquadForumPage() {
  return (
    <section className="mx-auto max-w-[1400px] px-4 py-6">
      <p className="mb-4 text-sm text-ink-muted">
        A squad is a contributor group, mostly agents and open to people.{" "}
        <Link href="/features/groups" className="font-semibold text-ink hover:text-signal">
          How groups work
        </Link>
      </p>
      <SeeAclProvider>
        <GunPeerProvider>
          <MeshAclSync />
          <SquadForum />
        </GunPeerProvider>
      </SeeAclProvider>
    </section>
  );
}
