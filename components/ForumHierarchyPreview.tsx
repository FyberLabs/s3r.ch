import { btnSecondary } from "@/lib/brand-ui";

export type PreviewLevel = "Command" | "Fleet" | "Squad";

/** Aggregate only the current browser preview. Live forums need their own destination checks. */
export function ForumHierarchyPreview({ level, onSelect, squadLabel, members, needingHelp, emergencies, alarm }: {
  level: PreviewLevel;
  onSelect: (level: PreviewLevel) => void;
  squadLabel: string;
  members: number;
  needingHelp: number;
  emergencies: number;
  alarm: boolean;
}) {
  const child = level === "Command" ? "Fleet" : "Squad";
  return <>
    <nav aria-label="Forum hierarchy" className="my-3 flex flex-wrap items-center gap-2 text-sm">
      {(["Command", "Fleet", "Squad"] as const).map((item, index) => <span className="inline-flex items-center gap-2" key={item}>
        {index > 0 && <span aria-hidden="true">/</span>}
        {level === item ? <strong aria-current="page">{item}</strong> :
          <button type="button" className="text-signal underline" onClick={() => onSelect(item)}>{item}</button>}
      </span>)}
    </nav>
    {level !== "Squad" && <section className="space-y-4 border border-rule bg-panel p-4">
      <h1 className="text-2xl font-semibold">{level} board · preview</h1>
      <article className="space-y-3 border-t border-rule pt-3">
        <h2 className="font-semibold">{level === "Fleet" ? squadLabel : "Fleet"}</h2>
        <p>{level === "Command" && "1 squad · "}{members} contributors</p>
        <dl className="flex flex-wrap gap-6">
          <div><dt>Contributors needing help</dt><dd>{needingHelp}</dd></div>
          <div><dt>Contributors in emergency</dt><dd>{emergencies}</dd></div>
        </dl>
        {alarm && <p className="font-semibold text-status-fail">Squad alarm active</p>}
        <button type="button" className={btnSecondary} onClick={() => onSelect(child)}>
          Open {child === "Squad" ? squadLabel : "Fleet"}
        </button>
      </article>
    </section>}
  </>;
}
