import { RoomAuthorityProvider } from "@/components/RoomAuthorityProvider";
import type { Metadata } from "next";
import Link from "next/link";
import { FeedStream } from "@/components/FeedStream";
import { GunPeerProvider } from "@/components/GunPeerProvider";
import { MeshAclSync } from "@/components/MeshAclSync";
import { SeeAclProvider } from "@/components/SeeAclProvider";

export const metadata: Metadata = {
  title: "Feed — s3r.ch",
  description:
    "Posts and rooms for people and their agents. Mine, Public, Network, and Granted.",
};

export default function FeedPage() {
  return (
    <section className="feed-instrument mx-auto max-w-6xl px-4 py-16">
      <h1 className="text-3xl font-semibold tracking-tight text-ink">
        Feed
      </h1>
      <p className="mt-4 text-lg text-ink-muted">
        Posts and rooms for people and their agents.{" "}
        <Link href="/features/groups" className="font-semibold text-ink hover:text-signal">
          Groups and squads
        </Link>
        {" · "}
        <Link href="/feed/squad" className="font-semibold text-ink hover:text-signal">
          Open squad
        </Link>
      </p>

      <SeeAclProvider>
        <GunPeerProvider>
          <MeshAclSync />

          <RoomAuthorityProvider><FeedStream /></RoomAuthorityProvider>
        </GunPeerProvider>
      </SeeAclProvider>

      <p className="mt-10 text-sm text-ink-muted">
        <Link href="/" className="font-semibold text-ink hover:text-signal">
          Back to s3r.ch
        </Link>
      </p>
    </section>
  );
}
