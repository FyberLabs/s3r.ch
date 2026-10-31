import { FeatureCards } from "@/components/FeatureCards";
import { IdentityBar } from "@/components/IdentityBar";
import { PublicFeedPreview } from "@/components/PublicFeedPreview";
import { SistersList } from "@/components/SistersList";
import { btnPrimary, btnSecondary } from "@/lib/brand-ui";

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
      <section className="landing-hero px-4 py-16 sm:py-24">
        <div className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-2 lg:items-start">
          <div>
            <h1 className="text-4xl font-semibold tracking-tight text-ink sm:text-6xl">
              s3r.ch
            </h1>
            <p className="mt-6 text-lg text-ink-muted sm:text-xl">
              Tagged posts and rooms.
            </p>
            <p className="mt-3 max-w-xl text-base text-ink-muted sm:text-lg">
              Sign in with a wallet or Hypermesh. Post to Mine, create a room, and
              share what you choose.
            </p>
            <p className="mt-8 flex flex-wrap gap-3">
              <a href="#sign-in" className={`inline-flex ${btnPrimary}`}>
                Sign in
              </a>
              <a href="/feed" className={`inline-flex ${btnSecondary}`}>
                Open feed
              </a>
            </p>
          </div>
          <div id="sign-in" className="scroll-mt-24 [&>.instrument-panel]:mt-0">
            <IdentityBar />
          </div>
        </div>
      </section>

      <section className="border-t border-rule px-4 py-16">
        <div className="mx-auto max-w-6xl">
          <h2 className="text-2xl font-semibold tracking-tight text-ink">
            Public feeds
          </h2>
          <p className="mt-3 max-w-2xl text-base text-ink-muted">
            Posts already pulled into s3r.ch from Farcaster, Bluesky, Nostr,
            ActivityPub, and RSS or Atom.
          </p>
          <PublicFeedPreview />
        </div>
      </section>

      <section className="border-t border-rule px-4 py-16">
        <div className="mx-auto max-w-6xl">
          <h2 className="text-2xl font-semibold tracking-tight text-ink">
            Features
          </h2>
          <p className="mt-3 max-w-2xl text-base text-ink-muted">
            How you talk, how groups work, and how sharing stays yours.
          </p>
          <FeatureCards />
        </div>
      </section>

      <section className="landing-sisters border-t border-rule px-4 py-8">
        <div className="mx-auto max-w-6xl">
          <h2 className="text-xs font-medium uppercase tracking-wide text-ink-muted">
            Related
          </h2>
          <SistersList sites={sisters} quiet />
        </div>
      </section>
    </>
  );
}
