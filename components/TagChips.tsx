"use client";

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
  if (tags.length === 0) return null;

  function toggle(tag: string) {
    onChange(
      selected.includes(tag)
        ? selected.filter((value) => value !== tag)
        : [...selected, tag],
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
