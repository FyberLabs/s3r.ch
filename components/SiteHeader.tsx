"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BrandControls } from "@/components/brand";

export function SiteHeader() {
  const pathname = usePathname();
  const showBrandControls = pathname === "/";

  return (
    <header className="sticky top-0 z-50 border-b border-rule bg-ground">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
        <Link href="/" className="flex items-center gap-2 text-lg tracking-tight text-ink">
          <span className="block size-3 shrink-0 bg-signal" aria-hidden />
          s3r.ch
        </Link>
        <nav className="flex flex-wrap items-center justify-end gap-x-5 gap-y-2 text-sm text-ink-muted">
          <Link href="/feed" className="hover:text-ink">
            Feed
          </Link>
          <a
            href="https://fyberlabs.com"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-ink"
          >
            Fyber Labs
          </a>
          {showBrandControls ? <BrandControls /> : null}
        </nav>
      </div>
    </header>
  );
}
