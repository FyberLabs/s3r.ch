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
            Fyber Labs
          </p>
          <h1 className="mt-3 text-4xl font-extrabold tracking-tight sm:text-6xl">
            s3r.ch
          </h1>
          <p className="mt-6 text-lg text-brand-100 sm:text-xl">
            A Fyber Labs lab site with a tagged social lab feed.
          </p>
          <p className="mx-auto mt-6 max-w-2xl text-base text-white/80">
            Gun-backed, under development.
          </p>
          <p className="mt-8">
            <a
              href="/feed"
              className="inline-flex rounded-lg bg-white/10 px-4 py-2 text-sm font-semibold text-white ring-1 ring-white/30 hover:bg-white/20"
            >
              Lab feed
            </a>
          </p>
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
