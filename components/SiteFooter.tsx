export function SiteFooter() {
  return (
    <footer className="mt-20 border-t border-rule py-10 text-center text-sm text-ink-muted">
      <p className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
        <a
          href="https://fyberlabs.com"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-ink"
        >
          Fyber Labs
        </a>
        <span aria-hidden="true">·</span>
        <a
          href="https://hyperme.sh"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-ink"
        >
          Hypermesh / Hyperme.sh
        </a>
        <a href="/privacy" className="underline hover:text-ink">Privacy Policy</a>
        <a href="/terms" className="underline hover:text-ink">Terms of Use</a>
        <a href="mailto:legal@s3r.ch" className="underline hover:text-ink">Contact</a>
      </p>
    </footer>
  );
}
