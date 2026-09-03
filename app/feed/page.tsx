import type { Metadata } from "next";
import Link from "next/link";
import { FeedStream } from "@/components/FeedStream";
import { IdentityBar } from "@/components/IdentityBar";
import { SeeAclProvider } from "@/components/SeeAclProvider";

export const metadata: Metadata = {
  title: "Lab feed — s3r.ch",
  description:
    "Tagged social lab feed from Fyber Labs. Gun-backed, under development.",
};

export default function FeedPage() {
  return (
    <section className="mx-auto max-w-3xl px-4 py-16">
      <p className="text-xs font-medium uppercase tracking-wide text-signal">
        Lab prototype
      </p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight text-ink">
        Feed
      </h1>
      <p className="mt-4 text-lg text-ink-muted">
        A Fyber Labs lab feed. Gun is the graph. Public Farcaster hub,
        ATProto AppView, and RSS activity is seeded into Gun on a cadence.
        RSS3 GI is optional. Signed-in, you can compose a native post onto
        Mine, or open a room thread. Share to public is explicit.
      </p>
      <p className="mt-3 text-sm text-ink-muted">
        Public and Mine tabs. Rooms are Gun objects, Mine by default. Tags
        first, then recency. There are no popular or novel columns. A
        see-grant is not delivery and not share-into-mesh. Sharing a room
        does not publish the posts inside it. Live chat is Gun subscriptions
        on a room you can already see. Presence and WebRTC are later. Trying
        seed peer; snapshot if the socket is down. Snapshot is not a chat
        log. That is not a P2P mesh. Outbound bridges are not enabled.
        Network is later.
      </p>

      <SeeAclProvider>
        <IdentityBar />

        <FeedStream />
      </SeeAclProvider>

      <p className="mt-10 text-sm text-ink-muted">
        <Link href="/" className="font-semibold text-ink hover:text-signal">
          Back to s3r.ch
        </Link>
        <span className="mx-2" aria-hidden="true">
          ·
        </span>
        <a
          href="https://docs.rss3.io/guide/developer/api"
          target="_blank"
          rel="noopener noreferrer"
          className="font-semibold text-ink hover:text-signal"
        >
          RSS3 Data Sublayer
        </a>
      </p>
    </section>
  );
}
