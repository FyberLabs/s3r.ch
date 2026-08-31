import Link from "next/link";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-50 border-b border-gray-200 bg-white/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <Link href="/" className="text-lg font-semibold tracking-tight text-brand-900">
          s3r.ch
        </Link>
        <nav className="flex flex-wrap items-center justify-end gap-x-5 gap-y-2 text-sm font-medium text-gray-600">
          <Link href="/feed" className="hover:text-brand-700">
            Feed
          </Link>
          <a
            href="https://fyberlabs.com"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-brand-700"
          >
            Fyber Labs
          </a>
        </nav>
      </div>
    </header>
  );
}
