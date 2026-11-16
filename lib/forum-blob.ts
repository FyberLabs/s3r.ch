/** Opt-in private forum document. All accepted mutations use the read ETag. */
import { createProductionBlobClient, type IdentityBlobClient } from "../identity-blob.cjs";
import { parseForumFile, type ForumFile, type ForumStore, type StoreLoad } from "./forum";

export const FORUM_BLOB = "forum.json";
export const MAX_FORUM_BYTES = 1048576;
type Snapshot = { channel: string; handle: string; bytes: string };
type Document = { schema: 1; forum: ForumFile; snapshots: Snapshot[] };

export function configuredForumBlobClient(): IdentityBlobClient {
  const account = process.env.S3RCH_FORUM_BLOB_ACCOUNT || "";
  const container = process.env.S3RCH_FORUM_BLOB_CONTAINER || "";
  if (!/^[a-z0-9]{3,24}$/.test(account) || !/^[a-z0-9](?:[a-z0-9]|-(?!-)){1,61}[a-z0-9]$/.test(container)) {
    throw new Error("Forum Blob bindings are required");
  }
  return createProductionBlobClient({ account, container, url: `https://${account}.blob.core.windows.net` });
}

export class BlobForumStore implements ForumStore {
  private etag: string | null = null;
  private document: Document | null = null;
  constructor(private readonly client: IdentityBlobClient) {}
  load(): StoreLoad {
    this.etag = null; this.document = null;
    try {
      const hit = this.client.download(FORUM_BLOB);
      if (!hit.found || !hit.etag || Buffer.byteLength(hit.text) > MAX_FORUM_BYTES) return { ok: false, reason: "store-unreadable" };
      const doc = JSON.parse(hit.text) as Document;
      if (doc.schema !== 1 || !Array.isArray(doc.snapshots)) return { ok: false, reason: "store-unreadable" };
      const parsed = parseForumFile(doc.forum);
      if (!parsed.ok) return parsed;
      const keys = new Set<string>();
      for (const row of doc.snapshots) {
        if (!row || typeof row.channel !== "string" || typeof row.handle !== "string" || typeof row.bytes !== "string" ||
            !parsed.file.desktops.some(d => d.channel === row.channel && d.snapshot?.handle === row.handle) ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(row.bytes) ||
            !row.bytes || Buffer.from(row.bytes, "base64").toString("base64") !== row.bytes) return { ok: false, reason: "store-unreadable" };
        const key = JSON.stringify([row.channel, row.handle]);
        if (keys.has(key)) return { ok: false, reason: "store-unreadable" };
        keys.add(key);
      }
      this.etag = hit.etag; this.document = { ...doc, forum: parsed.file };
      return { ok: true, file: structuredClone(parsed.file) };
    } catch { return { ok: false, reason: "store-unreadable" }; }
  }
  save(file: ForumFile, snapshot?: { channel: string; handle: string; bytes: Buffer | null }, cleanup = false): void {
    if (!this.etag || !this.document) throw new Error("Forum read required before write");
    const snapshots = this.document.snapshots.filter(row =>
      file.desktops.some(d => d.channel === row.channel && d.snapshot?.handle === row.handle) &&
      (!snapshot || row.channel !== snapshot.channel));
    if (snapshot?.bytes) snapshots.push({ ...snapshot, bytes: snapshot.bytes.toString("base64") });
    const doc: Document = { schema: 1, forum: file, snapshots };
    const text = JSON.stringify(doc);
    enforceQuota(doc, this.document, cleanup);
    if (Buffer.byteLength(text) > MAX_FORUM_BYTES) throw new Error("Forum document capacity exceeded");
    const result = this.client.upload(FORUM_BLOB, text, { ifMatch: this.etag });
    this.etag = result.etag; this.document = structuredClone(doc);
  }
  readSnapshot(channel: string, handle: string): Buffer | null {
    const row = this.document?.snapshots.find(row => row.channel === channel && row.handle === handle);
    return row ? Buffer.from(row.bytes, "base64") : null;
  }
}

/** Explicit migration only; callers must quiesce the old file writer first. */
export function migrateForum(client: IdentityBlobClient, file: unknown): void {
  const parsed = parseForumFile(file);
  if (!parsed.ok) throw new Error("Invalid source forum document");
  const text = JSON.stringify({ schema: 1, forum: parsed.file, snapshots: [] });
  if (Buffer.byteLength(text) > MAX_FORUM_BYTES) throw new Error("Forum document capacity exceeded");
  client.upload(FORUM_BLOB, text, { ifNoneMatch: "*" });
}

function quota(): never { throw Object.assign(new Error("Forum quota exceeded"), {code:"forum-quota"}); }
function ownerRows(doc: Document, owner: string) {
  const file = doc.forum;
  const channels = new Set(file.channels.filter(r => r.owner === owner).map(r => r.id));
  const groups = new Set(file.groups.filter(r => r.owner === owner).map(r => r.id));
  return {
    channels: file.channels.filter(r => r.owner === owner), bots: file.bots.filter(r => r.owner === owner),
    memberships: file.memberships.filter(r => channels.has(r.channel)), messages: file.messages.filter(r => channels.has(r.channel)),
    invites: file.invites.filter(r => channels.has(r.channel)), groups: file.groups.filter(r => r.owner === owner),
    groupMembers: file.groupMembers.filter(r => groups.has(r.group)), desktops: file.desktops.filter(r => channels.has(r.channel)),
    snapshots: doc.snapshots.filter(r => channels.has(r.channel)),
  };
}
function enforceQuota(next: Document, old: Document, cleanup: boolean) {
  // Only the archive/revocation model operations set cleanup. They cannot add
  // bots, messages, invites or snapshots. Reserve space for archival metadata.
  if (cleanup) return;
  if (Buffer.byteLength(JSON.stringify(next)) > MAX_FORUM_BYTES - 65536) quota();
  for (const owner of new Set(next.forum.channels.map(r => r.owner))) {
    const rows=ownerRows(next,owner), previous=ownerRows(old,owner);
    const limits={channels:1,bots:16,memberships:16,messages:128,invites:32,groups:8,groupMembers:64,desktops:1,snapshots:1};
    for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
      if (rows[key].length > Math.max(limits[key],previous[key].length)) quota();
    }
    if (Buffer.byteLength(JSON.stringify(rows)) > Math.max(65536,Buffer.byteLength(JSON.stringify(previous)))) quota();
  }
}
