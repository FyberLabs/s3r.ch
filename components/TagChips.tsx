"use client";

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
      <p className="text-xs font-medium uppercase tracking-wide text-brand-700">
        Tags
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onChange([])}
          className={`rounded-full border px-3 py-1 text-xs font-medium ${
            selected.length === 0
              ? "border-brand-700 bg-brand-700 text-white"
              : "border-brand-100 bg-white text-brand-900 hover:border-brand-500"
          }`}
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
              className={`rounded-full border px-3 py-1 text-xs font-medium ${
                active
                  ? "border-brand-700 bg-brand-700 text-white"
                  : "border-brand-100 bg-white text-brand-900 hover:border-brand-500"
              }`}
            >
              {tag}
            </button>
          );
        })}
      </div>
    </div>
  );
}
