import { SistersList } from "@/components/SistersList";
import { btnPrimary } from "@/lib/brand-ui";

const sisters = [
  {
    href: "https://fyberlabs.com",
    name: "Fyber Labs",
    copy: "Hardware, software, kits, and consulting.",
    host: "fyberlabs.com",
  },
  {
    href: "https://hyperme.sh",
    name: "Hypermesh / Hyperme.sh",
    copy: "Model and inference hardware rental.",
    host: "hyperme.sh",
  },
];

export default function Home() {
  return (
    <>
      <section className="landing-hero px-4 py-28">
        <div className="mx-auto max-w-4xl">
          <h1 className="text-4xl font-semibold tracking-tight text-ink sm:text-6xl">
            s3r.ch
          </h1>
          <p className="mt-6 text-lg text-ink-muted sm:text-xl">
            Tagged posts and rooms.
          </p>
          <p className="mt-3 max-w-2xl text-base text-ink-muted sm:text-lg">
            Sign in with a wallet or Hypermesh. Post to Mine, create a room, and
            share what you choose.
          </p>
          <p className="mt-8">
            <a href="/feed" className={`inline-flex ${btnPrimary}`}>
              Open feed
            </a>
          </p>
        </div>
      </section>

      <section className="landing-sisters border-t border-rule py-16">
        <div className="mx-auto max-w-4xl px-4">
          <h2 className="text-2xl font-semibold tracking-tight text-ink">
            Related
          </h2>
          <SistersList sites={sisters} />
        </div>
      </section>
    </>
  );
}
