"use client";

import { useBrand } from "@/components/brand";
import { chipOff, chipOn } from "@/lib/brand-ui";

export function TagChips({
  tags,
  selected,
  onChange,
  counts,
  heading = "Tags",
  flush = false,
}: {
  tags: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  /** Inventory per tag (posts · rooms). Not an engagement score. */
  counts?: Readonly<Record<string, { items: number; rooms: number }>>;
  heading?: string;
  flush?: boolean;
}) {
  const { reader } = useBrand();

  if (tags.length === 0) return null;

  function toggle(tag: string) {
    onChange(
      selected.includes(tag)
        ? selected.filter((value) => value !== tag)
        : [...selected, tag],
    );
  }

  if (reader === "ai") {
    return (
      <div className={flush ? undefined : "mt-8"}>
        {heading ? (
          <p className="text-xs font-medium uppercase tracking-wide text-signal">
            {heading}
          </p>
        ) : null}
        <div className={`${heading ? "mt-3" : ""} overflow-x-auto`}>
          <table className="brand-table">
            <thead>
              <tr>
                <th scope="col">tag</th>
                {counts ? (
                  <>
                    <th scope="col">items</th>
                    <th scope="col">rooms</th>
                  </>
                ) : null}
                <th scope="col">selected</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <button
                    type="button"
                    onClick={() => onChange([])}
                    className="text-ink hover:text-signal"
                  >
                    All
                  </button>
                </td>
                {counts ? (
                  <>
                    <td className="font-data"></td>
                    <td className="font-data"></td>
                  </>
                ) : null}
                <td className="font-data">{selected.length === 0 ? "true" : "false"}</td>
              </tr>
              {tags.map((tag) => {
                const active = selected.includes(tag);
                const count = counts?.[tag];
                return (
                  <tr key={tag}>
                    <td>
                      <button
                        type="button"
                        onClick={() => toggle(tag)}
                        className="text-ink hover:text-signal"
                      >
                        {tag}
                      </button>
                    </td>
                    {counts ? (
                      <>
                        <td className="font-data">{count?.items ?? 0}</td>
                        <td className="font-data">{count?.rooms ?? 0}</td>
                      </>
                    ) : null}
                    <td className="font-data">{active ? "true" : "false"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    <div className={flush ? undefined : "mt-8"}>
      {heading ? (
        <p className="text-xs font-medium uppercase tracking-wide text-signal">
          {heading}
        </p>
      ) : null}
      <div className={`${heading ? "mt-3" : ""} flex flex-wrap gap-2`}>
        <button
          type="button"
          onClick={() => onChange([])}
          className={selected.length === 0 ? chipOn : chipOff}
        >
          All
        </button>
        {tags.map((tag) => {
          const active = selected.includes(tag);
          const count = counts?.[tag];
          return (
            <button
              key={tag}
              type="button"
              onClick={() => toggle(tag)}
              className={active ? chipOn : chipOff}
            >
              {tag}
              {count ? (
                <span className={active ? "ml-1 text-on-signal" : "ml-1 text-ink-muted"}>
                  {count.items}·{count.rooms}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
