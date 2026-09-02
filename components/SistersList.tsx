"use client";

import { useBrand } from "@/components/brand";

export type SisterSite = {
  href: string;
  name: string;
  copy: string;
  host: string;
};

export function SistersList({ sites }: { sites: readonly SisterSite[] }) {
  const { reader } = useBrand();

  if (reader === "ai") {
    return (
      <div className="mt-8 overflow-x-auto">
        <table className="brand-table">
          <thead>
            <tr>
              <th scope="col">name</th>
              <th scope="col">copy</th>
              <th scope="col">host</th>
            </tr>
          </thead>
          <tbody>
            {sites.map((site) => (
              <tr key={site.href}>
                <td>
                  <a
                    href={site.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-ink hover:text-signal"
                  >
                    {site.name}
                  </a>
                </td>
                <td className="whitespace-normal">{site.copy}</td>
                <td className="font-data">{site.host}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="mt-8 grid gap-4 sm:grid-cols-3">
      {sites.map((site) => (
        <a
          key={site.href}
          href={site.href}
          target="_blank"
          rel="noopener noreferrer"
          className="border border-rule bg-panel p-5 hover:border-signal"
        >
          <h3 className="text-lg font-semibold text-ink">{site.name}</h3>
          <p className="mt-2 text-sm text-ink-muted">{site.copy}</p>
          <p className="mt-3 text-xs font-semibold text-signal">{site.host}</p>
        </a>
      ))}
    </div>
  );
}
