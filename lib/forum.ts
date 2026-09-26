/**
 * AI forum for humans, bots, and cloud agents.
 *
 * A signed-in owner (SIWE address) gets one forum channel. Bots and agents
 * are rows in that ledger. Restart looks the row up again. Copy mints a new
 * id and does not join. Archive keeps the row and the messages.
 *
 * Hyperme.sh and other tools can use this as a native collaboration surface
 * for orchestration. It is not Gun room chat, not a Hypermesh renter door,
 * and not a second API key.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getAddress } from "viem";
import { CHAT_BODY_MAX } from "./chat";

export const FORUM_FILE_V = 1;
export const FORUM_LABEL_MAX = 40;

export type ForumActorKind = "bot" | "cloud-agent";
export type ForumBotStatus = "active" | "archived";

export type ForumChannel = {
  id: string;
  owner: string;
  created: number;
  v: number;
};

export type ForumBot = {
  id: string;
  owner: string;
  label: string;
  kind: ForumActorKind;
  status: ForumBotStatus;
  created: number;
  archivedAt: number | null;
  v: number;
};

export type ForumMembership = {
  channel: string;
  bot: string;
  owner: string;
  joined: number;
};

export type ForumMessage = {
  id: string;
  channel: string;
  owner: string;
  bot: string;
  body: string;
  ts: number;
  v: number;
};

export type ForumBotView = ForumBot & { member: boolean };

export type ForumFile = {
  v: typeof FORUM_FILE_V;
  channels: ForumChannel[];
  bots: ForumBot[];
  memberships: ForumMembership[];
  messages: ForumMessage[];
};

export type StoreLoad =
  | { ok: true; file: ForumFile }
  | { ok: false; reason: "store-unreadable" | "unknown-version" };

export type ForumStore = {
  load(): StoreLoad;
  save(file: ForumFile): void;
};

export type Denied = { denied: true; reason: string };

export type RegisterBotInput = {
  owner: string;
  label: string;
  kind?: ForumActorKind;
  nowSeconds?: number;
  entropy?: string;
};

export type CopyBotInput = {
  owner: string;
  botId: string;
  label: string;
  nowSeconds?: number;
  entropy?: string;
};

export type BotRefInput = {
  owner: string;
  botId: string;
  nowSeconds?: number;
};

export type PostBotInput = {
  owner: string;
  botId: string;
  body: string;
  nowSeconds?: number;
  entropy?: string;
};

export type ReadChatInput = {
  owner: string;
  /** When set, the bot must already be a member. Omit for the owner account. */
  botId?: string;
};

export type RegisterBotResult =
  | Denied
  | { bot: ForumBotView; channel: ForumChannel };

export type CopyBotResult = Denied | { bot: ForumBotView; channel: ForumChannel };

export type ArchiveBotResult = Denied | { bot: ForumBotView };

export type JoinBotResult =
  | Denied
  | { bot: ForumBotView; channel: ForumChannel };

export type PostBotResult = Denied | { message: ForumMessage };

export type ReadChatResult =
  | Denied
  | {
      channel: ForumChannel | null;
      messages: ForumMessage[];
      bots: ForumBotView[];
    };

export type Forum = {
  registerBot(input: RegisterBotInput): RegisterBotResult;
  copyBot(input: CopyBotInput): CopyBotResult;
  archiveBot(input: BotRefInput): ArchiveBotResult;
  joinBot(input: BotRefInput): JoinBotResult;
  post(input: PostBotInput): PostBotResult;
  read(input: ReadChatInput): ReadChatResult;
};

type GlobalForum = typeof globalThis & {
  __s3rchForum?: Forum;
};

export function forumFilePath(): string {
  return process.env.S3RCH_FORUM || `${process.cwd()}/data/forum.json`;
}

export function emptyForumFile(): ForumFile {
  return {
    v: FORUM_FILE_V,
    channels: [],
    bots: [],
    memberships: [],
    messages: [],
  };
}

export class FileForumStore implements ForumStore {
  constructor(private readonly filePath: string) {}

  load(): StoreLoad {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { ok: true, file: emptyForumFile() };
      return { ok: false, reason: "store-unreadable" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return { ok: false, reason: "store-unreadable" };
    }
    return parseForumFile(parsed);
  }

  save(file: ForumFile): void {
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(file), "utf8");
    renameSync(tmp, this.filePath);
  }
}

export function getForum(): Forum {
  const g = globalThis as GlobalForum;
  if (!g.__s3rchForum) {
    g.__s3rchForum = openForum(new FileForumStore(forumFilePath()));
  }
  return g.__s3rchForum;
}

export function openForum(store: ForumStore): Forum {
  function load(): { ok: true; file: ForumFile } | Denied {
    let loaded: StoreLoad;
    try {
      loaded = store.load();
    } catch {
      return { denied: true, reason: "store-unreadable" };
    }
    if (!loaded.ok) return { denied: true, reason: loaded.reason };
    return { ok: true, file: loaded.file };
  }

  function commit(file: ForumFile): Denied | null {
    try {
      store.save(file);
      return null;
    } catch {
      return { denied: true, reason: "store-unreadable" };
    }
  }

  function registerBot(input: RegisterBotInput): RegisterBotResult {
    const owner = checksumOwner(input.owner);
    if (!owner) return { denied: true, reason: "bad-owner" };
    const label = cleanLabel(input.label);
    if (!label) return { denied: true, reason: "bad-label" };
    if (input.kind !== undefined && !isActorKind(input.kind)) {
      return { denied: true, reason: "bad-kind" };
    }
    const kind = input.kind ?? "bot";
    const opened = load();
    if ("denied" in opened) return opened;
    const file = opened.file;
    const existing = file.bots.find((row) => row.owner === owner && row.label === label);
    const now = nowSeconds(input.nowSeconds);
    if (existing) {
      if (input.kind !== undefined && existing.kind !== kind) {
        return { denied: true, reason: "kind-mismatch" };
      }
      const hadChannel = file.channels.some((row) => row.owner === owner);
      const channel = ensureChannel(file, owner, now);
      if (!hadChannel) {
        const saved = commit(file);
        if (saved) return saved;
      }
      return { bot: toView(file, existing), channel };
    }
    const entropy = cleanEntropy(input.entropy);
    if (!entropy) return { denied: true, reason: "bad-entropy" };
    const channel = ensureChannel(file, owner, now);
    const bot = createBot(file, owner, label, kind, now, entropy);
    if (!bot) return { denied: true, reason: "bad-entropy" };
    file.memberships.push({
      channel: channel.id,
      bot: bot.id,
      owner,
      joined: now,
    });
    const saved = commit(file);
    if (saved) return saved;
    return { bot: toView(file, bot), channel };
  }

  function copyBot(input: CopyBotInput): CopyBotResult {
    const owner = checksumOwner(input.owner);
    if (!owner) return { denied: true, reason: "bad-owner" };
    const label = cleanLabel(input.label);
    if (!label) return { denied: true, reason: "bad-label" };
    const opened = load();
    if ("denied" in opened) return opened;
    const file = opened.file;
    const source = botForOwner(file, owner, input.botId);
    if (!source) return { denied: true, reason: "unknown-bot" };
    if (file.bots.some((row) => row.owner === owner && row.label === label)) {
      return { denied: true, reason: "label-taken" };
    }
    const entropy = cleanEntropy(input.entropy);
    if (!entropy) return { denied: true, reason: "bad-entropy" };
    const now = nowSeconds(input.nowSeconds);
    const channel = ensureChannel(file, owner, now);
    const bot = createBot(file, owner, label, source.kind, now, entropy);
    if (!bot) return { denied: true, reason: "bad-entropy" };
    const saved = commit(file);
    if (saved) return saved;
    return { bot: toView(file, bot), channel };
  }

  // TRUNCATED_PLACEHOLDER_SEE_LOCAL - remaining content uploaded next
  return { registerBot, copyBot, archiveBot: () => ({ denied: true, reason: "incomplete" }), joinBot: () => ({ denied: true, reason: "incomplete" }), post: () => ({ denied: true, reason: "incomplete" }), read: () => ({ denied: true, reason: "incomplete" }) };
}
