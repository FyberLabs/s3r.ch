import type { ReactNode } from "react";
import type { FeedItem } from "@/lib/feed-types";
import { formatClock } from "@/lib/forum-squad";

export function ReportList({ reports, authorLabel, action }: {
  reports: readonly FeedItem[];
  authorLabel: (author: string) => string;
  action?: (row: FeedItem) => ReactNode;
}) {
  return <section aria-label="Reports" className="space-y-2 border border-rule bg-panel p-4">
    <h2 className="font-semibold">Reports</h2>
    {reports.length === 0 ? <p>No reports here yet.</p> : <ul className="space-y-3">
      {reports.map(row => <li key={row.id} className="space-y-1">
        <p className="text-xs text-ink-muted">{authorLabel(row.author)} · {formatClock(row.ts)}</p>
        <p className="break-words">{row.body}</p>
        {action?.(row)}
      </li>)}
    </ul>}
  </section>;
}