import { isCanonicalObjectId } from "./identity/object-id";

const PREFIX = "s3rch-media:v1:";
/** References carry no key, wrap, storage location, filename or access grant. */
export function parseRoomMedia(body: unknown): string | null {
  if (typeof body !== "string" || body.length > 512 || !body.startsWith(PREFIX)) return null;
  try {
    const row: unknown = JSON.parse(body.slice(PREFIX.length));
    return Array.isArray(row) && row.length === 1 && typeof row[0] === "string" &&
      row[0].startsWith("media_") && isCanonicalObjectId(row[0]) ? row[0] : null;
  } catch { return null; }
}
export function composeRoomMedia(object: string): string | null {
  const body = PREFIX + JSON.stringify([object]);
  return parseRoomMedia(body) ? body : null;
}
export function roomMediaText(body: string): string {
  return parseRoomMedia(body) ? "Private media reference — open with your own file access below." : body;
}
