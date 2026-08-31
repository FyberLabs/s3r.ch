import type { Metadata } from "next";
import Link from "next/link";
import { getFeed, type FeedRow } from "@/lib/rss3-feed";

export const metadata: Metadata = {
  title: "Activity board — s3r.ch",
  description:
    "Public RSS3-backed activity board for research. Not a social network, not a live search product, not financial advice.",
};

export const dynamic = "force-dynamic";

export default async function FeedPage() {
  const feed = await getFeed();

  return (
    <section className="mx-auto max-w-6xl px-4 py-16">
      <p className="text-xs font-medium uppercase tracking-wide text-brand-700">
        Public RSS3 activity
      </p>
      <h1 className="mt-2 text-3xl font-bold tracking-tight text-brand-900">
        Activity board
      </h1>
      <p className="mt-4 max-w-3xl text-lg text-gray-600">
        A public RSS3-backed activity board for research. It reads recent
        social posts and contract interactions from the RSS3 Data Sublayer
        (network and platform activities). It is not a social network, not a
        live search product, and not financial advice.
      </p>
      <p className="mt-3 max-w-3xl text-sm text-gray-500">
        Popular is whatever repeated most in this window. Novel is first-seen
        here (count of 1). There is no owned social graph and no search-box
        query API — RSS3 indexes posts and activities, not search terms.
      </p>

      {feed.error ? (
        <div className="mt-10 rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-900">
          <p className="font-semibold">RSS3 did not return a feed</p>
          <p className="mt-2">{feed.error}</p>
          <p className="mt-2 text-red-800">
            No rows were invented. Sources ok {feed.sourcesOk} /{" "}
            {feed.sourcesTried}.
          </p>
        </div>
      ) : (
        <p className="mt-6 text-xs text-gray-400">
          Fetched {feed.fetchedAt} · GI sources {feed.sourcesOk} /{" "}
          {feed.sourcesTried} · cached about 60s
        </p>
      )}

      <div className="mt-10 grid gap-8 lg:grid-cols-2">
        <Rail
          title="Popular"
          empty="No contract or social target repeated in this RSS3 window."
          rows={feed.popular}
        />
        <Rail
          title="Novel"
          empty="No first-seen contract or social target in this RSS3 window."
          rows={feed.novel}
        />
      </div>

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

function Rail({
  title,
  empty,
  rows,
}: {
  title: string;
  empty: string;
  rows: FeedRow[];
}) {
  return (
    <div>
      <h2 className="text-xl font-semibold text-brand-900">{title}</h2>
      {rows.length === 0 ? (
        <p className="mt-4 rounded-xl border border-brand-100 bg-brand-50/40 p-6 text-sm text-gray-600">
          {empty}
        </p>
      ) : (
        <ul className="mt-4 space-y-3">
          {rows.map((row) => (
            <li key={row.key}>
              <FeedCard row={row} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FeedCard({ row }: { row: FeedRow }) {
  const when = row.timestamp
    ? new Date(row.timestamp * 1000).toISOString().replace(".000Z", "Z")
    : null;
  const meta = [row.network, row.platform].filter(Boolean).join(" · ");
  const inner = (
    <>
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-base font-semibold text-brand-900">{row.label}</h3>
        <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-brand-700">
          {row.kind === "social" ? "social" : "contract"}
        </span>
      </div>
      <p className="mt-1 text-sm text-gray-600">{row.action}</p>
      <p className="mt-2 text-xs text-gray-500">
        {row.novelty === "first-seen"
          ? "First seen in this window"
          : `Seen ${row.count} times in this window`}
        {meta ? ` · ${meta}` : ""}
        {when ? ` · ${when}` : ""}
      </p>
    </>
  );

  const className =
    "block rounded-xl border border-brand-100 bg-gradient-to-b from-white to-brand-50/40 p-5 shadow-sm";

  if (row.href) {
    return (
      <a
        href={row.href}
        target="_blank"
        rel="noopener noreferrer"
        className={`${className} hover:border-brand-500`}
      >
        {inner}
      </a>
    );
  }

  return <div className={className}>{inner}</div>;
}
