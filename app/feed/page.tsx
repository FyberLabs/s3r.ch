import type { Metadata } from "next";
import Link from "next/link";
import { FeedStream } from "@/components/FeedStream";
import { GunPeerProvider } from "@/components/GunPeerProvider";
import { IdentityBar } from "@/components/IdentityBar";
import { SeeAclProvider } from "@/components/SeeAclProvider";

export const metadata: Metadata = {
  title: "Lab feed — s3r.ch",
  description: "Tagged posts and rooms from Fyber Labs.",
};

export default function FeedPage() {
  return (
    <section className="feed-instrument mx-auto max-w-6xl px-4 py-16">
      <h1 className="text-3xl font-semibold tracking-tight text-ink">
        Feed
      </h1>
      <p className="mt-4 text-lg text-ink-muted">
        Tagged posts and rooms.
      </p>

      <SeeAclProvider>
        <GunPeerProvider>
          <IdentityBar />

          <FeedStream />
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
