"use client";

import { chipOff, chipOn } from "@/lib/brand-ui";

export function TagChips({
  tags,
  selected,
  onChange,
}: {
  tags: string[];
  selected: string[];
  onChange: (next: string[]) => void;
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
    <div className="mt-8">
      <p className="text-xs font-medium uppercase tracking-wide text-signal">
        Tags
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onChange([])}
          className={selected.length === 0 ? chipOn : chipOff}
        >
          All
        </button>
        {tags.map((tag) => {
          const active = selected.includes(tag);
          return (
            <button
              key={tag}
              type="button"
              onClick={() => toggle(tag)}
              className={active ? chipOn : chipOff}
            >
              {tag}
            </button>
          );
        })}
      </div>
    </div>
  );
}
