import type { Metadata } from "next";
import Link from "next/link";
import { FeedStream } from "@/components/FeedStream";

export const metadata: Metadata = {
  title: "Lab feed — s3r.ch",
  description:
    "Fyber Labs prototype feed on GunDB. Not a live search product, not financial advice.",
};

export default function FeedPage() {
  return (
    <section className="mx-auto max-w-3xl px-4 py-16">
      <p className="text-xs font-medium uppercase tracking-wide text-brand-700">
        Lab prototype
      </p>
      <h1 className="mt-2 text-3xl font-bold tracking-tight text-brand-900">
        Feed
      </h1>
      <p className="mt-4 text-lg text-gray-600">
        A Fyber Labs prototype. Gun is the graph. Public Farcaster hub,
        ATProto AppView, and RSS activity is seeded into Gun on a cadence.
        RSS3 GI is optional. This is not a live search product and not
        financial advice.
      </p>
      <p className="mt-3 text-sm text-gray-500">
        One stream, tags first. There are no popular or novel columns. Outbound
        posting is not enabled.
      </p>

      <FeedStream />

      <p className="mt-10 text-sm text-gray-500">
        <Link href="/" className="font-semibold text-brand-700 hover:underline">
          Back to s3r.ch
        </Link>
        <span className="mx-2" aria-hidden="true">
          ·
        </span>
        <a
          href="https://docs.rss3.io/guide/developer/api"
          target="_blank"
          rel="noopener noreferrer"
          className="font-semibold text-brand-700 hover:underline"
        >
          RSS3 Data Sublayer
        </a>
      </p>
    </section>
  );
}
