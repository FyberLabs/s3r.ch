import Link from "next/link";
import { FEATURES } from "@/lib/features";

export function FeatureCards() {
  return (
    <div className="mt-8 grid gap-4 sm:grid-cols-2">
      {FEATURES.map((feature) => (
        <Link
          key={feature.href}
          href={feature.href}
          className="border border-rule bg-panel p-5 hover:border-signal"
        >
          <h3 className="text-lg font-semibold text-ink">{feature.title}</h3>
          <p className="mt-2 text-sm text-ink-muted">{feature.copy}</p>
        </Link>
      ))}
    </div>
  );
}
