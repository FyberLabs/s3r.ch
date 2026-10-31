import Link from "next/link";
import type { ReactNode } from "react";
import { btnPrimary, btnSecondary } from "@/lib/brand-ui";

export type FeatureAction = {
  href: string;
  label: string;
  tone?: "primary" | "secondary";
};

export function FeatureArticle({
  title,
  lede,
  actions,
  children,
}: {
  title: string;
  lede: string;
  actions?: readonly FeatureAction[];
  children: ReactNode;
}) {
  return (
    <article className="mx-auto max-w-3xl px-4 py-16">
      <p className="text-xs font-medium uppercase tracking-wide text-signal">
        <Link href="/features" className="hover:text-ink">
          Features
        </Link>
      </p>
      <h1 className="mt-3 text-4xl font-semibold tracking-tight text-ink">{title}</h1>
      <p className="mt-6 text-lg text-ink-muted">{lede}</p>
      {actions && actions.length > 0 ? (
        <p className="mt-8 flex flex-wrap gap-3">
          {actions.map((action) => (
            <Link
              key={`${action.href}-${action.label}`}
              href={action.href}
              className={`inline-flex ${action.tone === "secondary" ? btnSecondary : btnPrimary}`}
            >
              {action.label}
            </Link>
          ))}
        </p>
      ) : null}
      <div className="mt-12 space-y-10">{children}</div>
    </article>
  );
}

export function FeatureSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section>
      <h2 className="text-2xl font-semibold tracking-tight text-ink">{title}</h2>
      <div className="mt-3 space-y-3 text-base text-ink-muted">{children}</div>
    </section>
  );
}
