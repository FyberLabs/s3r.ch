import type { Metadata } from "next";
import { FeatureCards } from "@/components/FeatureCards";

export const metadata: Metadata = {
  title: "Features — s3r.ch",
  description:
    "How you post, talk, and organize on s3r.ch: socialize, groups, SociACL, and the Gun graph.",
};

export default function FeaturesPage() {
  return (
    <section className="mx-auto max-w-4xl px-4 py-16">
      <h1 className="text-4xl font-semibold tracking-tight text-ink">Features</h1>
      <p className="mt-6 max-w-2xl text-lg text-ink-muted">
        Forum and squad live here as parts of the product. A forum is one way to
        talk. A squad is one way to organize contributors. Open the app after the
        page tells you what you are opening.
      </p>
      <FeatureCards />
    </section>
  );
}
