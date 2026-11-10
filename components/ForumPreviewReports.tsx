import { btnSecondary } from "@/lib/brand-ui";
import type { FeedItem } from "@/lib/feed-types";
import { formatClock } from "@/lib/forum-squad";
import type { PreviewLevel } from "./ForumHierarchyPreview";

export function ForumPreviewReports({ level, chat, shared, authorLabel, onToggle }: {
  level: PreviewLevel;
  chat: readonly FeedItem[];
  shared: ReadonlyMap<FeedItem, "Fleet" | "Command">;
  authorLabel: (author: string) => string;
  onToggle: (report: FeedItem) => void;
}) {
  const reports = chat.filter(row => row.tags.includes("report") &&
    (level === "Squad" || shared.get(row) === "Command" || (level === "Fleet" && shared.has(row))));
  return <section aria-label="Reports" className="space-y-2 border border-rule bg-panel p-4">
    <h2 className="font-semibold">Reports</h2>
    {reports.length === 0 ? <p>No reports here yet.</p> : <ul className="space-y-3">
      {reports.map(row => <li key={row.id} className="space-y-1">
        <p className="text-xs text-ink-muted">{authorLabel(row.author)} · {formatClock(row.ts)}</p>
        <p className="break-words">{row.body}</p>
        {level !== "Command" && <button className={btnSecondary} type="button" onClick={() => onToggle(row)}>
          {level === "Squad" ? (shared.has(row) ? "Withdraw from Fleet" : "Send to Fleet")
            : (shared.get(row) === "Command" ? "Withdraw from Command" : "Send to Command")}
        </button>}
      </li>)}
    </ul>}
  </section>;
}
