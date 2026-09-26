/**
 * What the forum page shows for a visor desktop.
 *
 * Panels come only from channels the read already returned: the caller's
 * own channel, and channels shared by invite or group. Image bytes are not
 * in this object. The snapshot URL is the private forum GET.
 */

export type DeskThinking = {
  kind: string;
  text: string;
};

export type DeskRow = {
  session: string;
  snapshot: { handle: string; mime: string; seq: number } | null;
  thinking: DeskThinking[];
  files: { handle: string }[];
  secrets: { handle: string }[];
};

export type DeskRead = {
  channel: { id: string; owner: string } | null;
  desktop: DeskRow | null;
  shared: {
    channel: { id: string; owner: string };
    desktop: DeskRow | null;
  }[];
};

export type DeskPanel = {
  owner: string;
  role: "owner" | "renter";
  session: string | null;
  snapshotUrl: string | null;
  snapshotHandle: string | null;
  thinking: DeskThinking[];
  files: string[];
  secrets: string[];
};

export function deskPanels(read: DeskRead): DeskPanel[] {
  const panels: DeskPanel[] = [];
  if (read.channel) panels.push(toPanel(read.channel.owner, "owner", read.desktop));
  for (const shared of read.shared) {
    panels.push(toPanel(shared.channel.owner, "renter", shared.desktop));
  }
  return panels;
}

export function snapshotUrl(handle: string): string {
  return `/api/forum?snapshot=${encodeURIComponent(handle)}`;
}

function toPanel(
  owner: string,
  role: DeskPanel["role"],
  desktop: DeskRow | null,
): DeskPanel {
  const handle = desktop?.snapshot?.handle ?? null;
  return {
    owner,
    role,
    session: desktop?.session ?? null,
    snapshotUrl: handle ? snapshotUrl(handle) : null,
    snapshotHandle: handle,
    thinking: desktop?.thinking ?? [],
    files: (desktop?.files ?? []).map((row) => row.handle),
    secrets: (desktop?.secrets ?? []).map((row) => row.handle),
  };
}
