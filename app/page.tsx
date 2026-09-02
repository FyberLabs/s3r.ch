import { SistersList } from "@/components/SistersList";
import { btnPrimary } from "@/lib/brand-ui";

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
      <section className="landing-hero px-4 py-28">
        <div className="mx-auto max-w-4xl">
          <p className="text-xs font-medium uppercase tracking-wide text-signal">
            Fyber Labs
          </p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight text-ink sm:text-6xl">
            s3r.ch
          </h1>
          <p className="mt-6 text-lg text-ink-muted sm:text-xl">
            A Fyber Labs lab site with a tagged social lab feed.
          </p>
          <p className="mt-6 max-w-2xl text-base text-ink-muted">
            Gun-backed, under development.
          </p>
          <p className="mt-8">
            <a href="/feed" className={`inline-flex ${btnPrimary}`}>
              Lab feed
            </a>
          </p>
        </div>
      </section>

      <section className="landing-sisters border-t border-rule py-16">
        <div className="mx-auto max-w-4xl px-4">
          <h2 className="text-2xl font-semibold tracking-tight text-ink">
            Also from Fyber Labs
          </h2>
          <SistersList sites={sisters} />
        </div>
      </section>
    </>
  );
}
