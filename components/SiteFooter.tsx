export function SiteFooter() {
  return (
    <footer className="mt-20 border-t border-gray-200 py-10 text-center text-sm text-gray-400">
      <p>
        A{" "}
        <a
          href="https://fyberlabs.com"
          target="_blank"
          rel="noopener noreferrer"
          className="text-gray-500 hover:text-gray-600"
        >
          Fyber Labs
        </a>{" "}
        lab site · Chris Hamilton
      </p>
      <p className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
        <a
          href="https://fyberlabs.com"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-gray-600"
        >
          Fyber Labs
        </a>
        <span aria-hidden="true">·</span>
        <a
          href="https://hyperme.sh"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-gray-600"
        >
          Hypermesh / Hyperme.sh
        </a>
        <span aria-hidden="true">·</span>
        <a
          href="https://tennesseewindage.com"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-gray-600"
        >
          Tennessee Windage
        </a>
      </p>
    </footer>
  );
}
