/** Local owner approvals are separate from untrusted forum task references. */
import { constants, openSync, closeSync, fstatSync, readSync, lstatSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { isSeaPubkey } from "./identity/forum-check";
import type { BotInboxScope } from "./forum-bot-inbox";
const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
export type LocalBotApproval = Readonly<{
  version: 1; tenant: string; forum: string; bot: string; principal: string;
  handle: string; session: string; expires: number; revoked: boolean;
  task: Readonly<{ steps: readonly Readonly<{ tool: string; arguments: Record<string, unknown> }>[] }>;
  artifactReaders: readonly string[];
}>;
export function privateBotDirectory(path: string) {
  if (!isAbsolute(path) || !process.getuid) throw Error("Private Unix directory required");
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077))
    throw Error("Private owner directory required");
}
export function readPrivateBotFile(path: string, limit = 65536): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!process.getuid || !stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > limit)
      throw Error("Private owner file required");
    const data = Buffer.alloc(limit + 1); let size = 0;
    for (;;) { const count = readSync(fd, data, size, data.length - size, null); if (!count) break; size += count;
      if (size > limit) throw Error("Private file too large"); }
    return data.subarray(0, size);
  } finally { closeSync(fd); }
}
export function openLocalBotApprovals(directory: string, scope: BotInboxScope, clock = () => Math.floor(Date.now() / 1000)) {
  privateBotDirectory(directory);
  const binding = Object.freeze({ ...scope });
  return Object.freeze({
    read(handle: string): LocalBotApproval | null {
      try {
        if (!uuid(handle)) return null;
        privateBotDirectory(directory);
        const row = JSON.parse(readPrivateBotFile(join(directory, handle + ".json")).toString("utf8"));
        const at = clock();
        if (!row || Object.keys(row).sort().join() !== "artifactReaders,bot,expires,forum,handle,principal,revoked,session,task,tenant,version" ||
            row.version !== 1 || row.tenant !== binding.tenant || row.forum !== binding.forum || row.bot !== binding.bot ||
            row.principal !== binding.principal || row.handle !== handle || !uuid(row.session) || row.revoked !== false ||
            !Number.isSafeInteger(at) || at < 0 || !Number.isSafeInteger(row.expires) || row.expires <= at ||
            !Array.isArray(row.artifactReaders) || row.artifactReaders.length > 32 ||
            new Set(row.artifactReaders).size !== row.artifactReaders.length || !row.artifactReaders.every(isSeaPubkey) ||
            !row.task || Object.keys(row.task).join() !== "steps" || !Array.isArray(row.task.steps) ||
            row.task.steps.length < 1 || row.task.steps.length > 16 || row.task.steps.some((step: any) =>
              !step || Object.keys(step).sort().join() !== "arguments,tool" ||
              !["view", "mouse_move", "mouse_click", "mouse_drag", "mouse_scroll", "type_text", "key_chord"].includes(step.tool) ||
              !step.arguments || typeof step.arguments !== "object" || Array.isArray(step.arguments))) return null;
        // Visor's own closed verb schema validates arguments again before enqueue.
        const freeze = (v: any) => { if (v && typeof v === "object") { Object.values(v).forEach(freeze); Object.freeze(v); } };
        freeze(row); return row as LocalBotApproval;
      } catch { return null; }
    },
  });
}
