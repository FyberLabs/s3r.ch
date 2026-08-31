import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Research notes — s3r.ch",
  description:
    "2019 session and group selection diagrams from the s3r.ch repository.",
};

const diagrams = [
  {
    id: "session",
    title: "Session management",
    sourceHref: "/docs/session-uc.wsd",
    sourceName: "session-uc.wsd",
    image: "/docs/session-uc.png",
  },
  {
    id: "group",
    title: "Group selection",
    sourceHref: "/docs/group-uc.wsd",
    sourceName: "group-uc.wsd",
    image: "/docs/group-uc.png",
  },
];

export default function ResearchPage() {
  return (
    <section className="mx-auto max-w-4xl px-4 py-16">
      <p className="text-xs font-medium uppercase tracking-wide text-brand-700">
        Recovered from this repository
      </p>
      <h1 className="mt-2 text-3xl font-bold tracking-tight text-brand-900">
        Research notes
      </h1>
      <p className="mt-4 text-lg text-gray-600">
        These 2019 PlantUML diagrams are the surviving design notes in this
        repo: session management and group selection. They are not a product
        specification, and this site is not a live search service.
      </p>
      <p className="mt-3 text-sm text-gray-500">
        Source files stay at the repository root (
        <code className="rounded bg-brand-50 px-1 py-0.5 text-brand-900">
          session-uc.wsd
        </code>
        ,{" "}
        <code className="rounded bg-brand-50 px-1 py-0.5 text-brand-900">
          group-uc.wsd
        </code>
        ) and are also served from{" "}
        <code className="rounded bg-brand-50 px-1 py-0.5 text-brand-900">
          /docs
        </code>
        .
      </p>

      <div className="mt-12 space-y-12">
        {diagrams.map((diagram) => (
          <article
            key={diagram.id}
            id={diagram.id}
            className="rounded-xl border border-brand-100 bg-white p-6 shadow-sm"
          >
            <h2 className="text-xl font-semibold text-brand-900">
              {diagram.title}
            </h2>
            <p className="mt-2 text-sm text-gray-500">
              <a
                href={diagram.sourceHref}
                className="font-semibold text-brand-700 hover:underline"
              >
                {diagram.sourceName}
              </a>
            </p>
            <div className="mt-6 overflow-x-auto rounded-lg border border-brand-100 bg-brand-50/40 p-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={diagram.image}
                alt={`${diagram.title} PlantUML diagram`}
                className="mx-auto max-w-full"
              />
            </div>
          </article>
        ))}
      </div>

      <p className="mt-10 text-sm text-gray-500">
        <Link href="/" className="font-semibold text-brand-700 hover:underline">
          Back to s3r.ch
        </Link>
      </p>
    </section>
  );
}
