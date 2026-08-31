import Link from "next/link";

const sisters = [
  {
    href: "https://fyberlabs.com",
    name: "Fyber Labs",
    copy: "Chris Hamilton's lab. Hardware, software, kits, and consulting.",
    host: "fyberlabs.com",
  },
  {
    href: "https://hyperme.sh",
    name: "Hypermesh / Hyperme.sh",
    copy: "Model and inference hardware rental.",
    host: "hyperme.sh",
  },
  {
    href: "https://tennesseewindage.com",
    name: "Tennessee Windage",
    copy: "Targeting computer for rifles. Hardware in development.",
    host: "tennesseewindage.com",
  },
];

export default function Home() {
  return (
    <>
      <section className="relative overflow-hidden bg-gradient-to-br from-brand-900 via-brand-700 to-brand-500 py-28 text-white">
        <div className="mx-auto max-w-4xl px-4 text-center">
          <p className="text-xs font-medium uppercase tracking-wide text-brand-100">
            Research / recovering
          </p>
          <h1 className="mt-3 text-4xl font-extrabold tracking-tight sm:text-6xl">
            s3r.ch
          </h1>
          <p className="mt-6 text-lg text-brand-100 sm:text-xl">
            Research on crypto, contracts, social search, and trust.
          </p>
          <p className="mx-auto mt-6 max-w-2xl text-base text-white/80">
            A Fyber Labs research note. This domain is being recovered. It is
            not a live search product.
          </p>
          <div className="mt-10 flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
            <Link
              href="/research"
              className="rounded-lg bg-white px-8 py-3 text-base font-semibold text-brand-700 shadow hover:bg-brand-50"
            >
              2019 research notes
            </Link>
            <a
              href="https://fyberlabs.com"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg border border-white/50 px-8 py-3 text-base font-semibold text-white hover:bg-white/10"
            >
              Fyber Labs
            </a>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-4xl px-4 py-20">
        <h2 className="text-3xl font-bold tracking-tight">Status</h2>
        <p className="mt-4 text-lg text-gray-600">
          s3r.ch is research from Chris Hamilton&apos;s lab, Fyber Labs. What
          remains here is an honest landing and the original PlantUML notes
          from this repository. There is no search index, account system, or
          marketplace on this site.
        </p>
        <div className="mt-12 grid gap-8 sm:grid-cols-2">
          <div className="rounded-xl border border-brand-100 bg-gradient-to-b from-white to-brand-50/40 p-6 shadow-sm">
            <h3 className="text-lg font-semibold text-brand-900">
              Research notes
            </h3>
            <p className="mt-2 text-sm text-gray-600">
              Session and group selection diagrams from 2019, still in this
              repo.
            </p>
            <Link
              href="/research"
              className="mt-4 inline-block text-sm font-semibold text-brand-700 hover:underline"
            >
              View the diagrams
            </Link>
          </div>
          <div className="rounded-xl border border-brand-100 bg-gradient-to-b from-white to-brand-50/40 p-6 shadow-sm">
            <h3 className="text-lg font-semibold text-brand-900">
              Not a product
            </h3>
            <p className="mt-2 text-sm text-gray-600">
              No live search, login, or token. Recovering the public page, not
              launching a service.
            </p>
          </div>
        </div>
      </section>

      <section className="bg-brand-50 py-16">
        <div className="mx-auto max-w-4xl px-4">
          <h2 className="text-2xl font-bold tracking-tight text-brand-900">
            Also from Fyber Labs
          </h2>
          <div className="mt-8 grid gap-4 sm:grid-cols-3">
            {sisters.map((site) => (
              <a
                key={site.href}
                href={site.href}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-xl border border-brand-100 bg-gradient-to-b from-white to-brand-50/40 p-5 shadow-sm hover:border-brand-500"
              >
                <h3 className="text-lg font-semibold text-brand-900">
                  {site.name}
                </h3>
                <p className="mt-2 text-sm text-gray-600">{site.copy}</p>
                <p className="mt-3 text-xs font-semibold text-brand-700">
                  {site.host}
                </p>
              </a>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
