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

  function archiveBot(input: BotRefInput): ArchiveBotResult {
    const owner = checksumOwner(input.owner);
    if (!owner) return { denied: true, reason: "bad-owner" };
    const opened = load();
    if ("denied" in opened) return opened;
    const file = opened.file;
    const bot = botForOwner(file, owner, input.botId);
    if (!bot) return { denied: true, reason: "unknown-bot" };
    if (bot.status !== "archived") {
      bot.status = "archived";
      bot.archivedAt = nowSeconds(input.nowSeconds);
      const saved = commit(file);
      if (saved) return saved;
    }
    return { bot: toView(file, bot) };
  }

  function joinBot(input: BotRefInput): JoinBotResult {
    const owner = checksumOwner(input.owner);
    if (!owner) return { denied: true, reason: "bad-owner" };
    const opened = load();
    if ("denied" in opened) return opened;
    const file = opened.file;
    const bot = botForOwner(file, owner, input.botId);
    if (!bot) return { denied: true, reason: "unknown-bot" };
    if (bot.status !== "active") return { denied: true, reason: "archived" };
    const now = nowSeconds(input.nowSeconds);
    const channel = ensureChannel(file, owner, now);
    if (!isMember(file, channel.id, bot.id)) {
      file.memberships.push({
        channel: channel.id,
        bot: bot.id,
        owner,
        joined: now,
      });
      const saved = commit(file);
      if (saved) return saved;
    }
    return { bot: toView(file, bot), channel };
  }

  function post(input: PostBotInput): PostBotResult {
    const owner = checksumOwner(input.owner);
    if (!owner) return { denied: true, reason: "bad-owner" };
    const body = input.body.trim();
    if (!body || body.length > CHAT_BODY_MAX) return { denied: true, reason: "bad-body" };
    const opened = load();
    if ("denied" in opened) return opened;
    const file = opened.file;
    const bot = botForOwner(file, owner, input.botId);
    if (!bot) return { denied: true, reason: "unknown-bot" };
    if (bot.status !== "active") return { denied: true, reason: "archived" };
    const channel = file.channels.find((row) => row.owner === owner);
    if (!channel || !isMember(file, channel.id, bot.id)) {
      return { denied: true, reason: "not-member" };
    }
    const entropy = cleanEntropy(input.entropy);
    if (!entropy) return { denied: true, reason: "bad-entropy" };
    const ts = nowSeconds(input.nowSeconds);
    const id = `s3rch:forum-msg:${owner}:${ts}:${entropy}`;
    if (file.messages.some((row) => row.id === id)) {
      return { denied: true, reason: "bad-entropy" };
    }
    const message: ForumMessage = {
      id,
      channel: channel.id,
      owner,
      bot: bot.id,
      body,
      ts,
      v: FORUM_FILE_V,
    };
    file.messages.push(message);
    const saved = commit(file);
    if (saved) return saved;
    return { message };
  }

  function read(input: ReadChatInput): ReadChatResult {
    const owner = checksumOwner(input.owner);
    if (!owner) return { denied: true, reason: "bad-owner" };
    const opened = load();
    if ("denied" in opened) return opened;
    const file = opened.file;
    const channel = file.channels.find((row) => row.owner === owner) ?? null;
    if (input.botId !== undefined) {
      const bot = botForOwner(file, owner, input.botId);
      if (!bot) return { denied: true, reason: "unknown-bot" };
      if (!channel || !isMember(file, channel.id, bot.id)) {
        return { denied: true, reason: "not-member" };
      }
    }
    const messages = file.messages
      .filter((row) => row.owner === owner && (!channel || row.channel === channel.id))
      .slice()
      .sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
    const bots = file.bots
      .filter((row) => row.owner === owner)
      .map((row) => toView(file, row))
      .sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
    return { channel, messages, bots };
  }

  return { registerBot, copyBot, archiveBot, joinBot, post, read };
}

export type ForumHttpResult = {
  status: number;
  body: Record<string, unknown>;
};

export function handleForumGet(
  chat: Forum,
  owner: string,
): ForumHttpResult {
  return readResult(chat.read({ owner }));
}

export function handleForumPost(
  chat: Forum,
  owner: string,
  input: unknown,
): ForumHttpResult {
  if (!input || typeof input !== "object") {
    return { status: 400, body: { error: "Expected JSON." } };
  }
  const record = input as Record<string, unknown>;
  const action = record.action;
  if (action === "register") {
    return mapResult(
      chat.registerBot({
        owner,
        label: typeof record.label === "string" ? record.label : "",
        kind: record.kind as ForumActorKind | undefined,
        nowSeconds: asSeconds(record.nowSeconds),
        entropy: typeof record.entropy === "string" ? record.entropy : undefined,
      }),
    );
  }
  if (action === "copy") {
    return mapResult(
      chat.copyBot({
        owner,
        botId: typeof record.botId === "string" ? record.botId : "",
        label: typeof record.label === "string" ? record.label : "",
        nowSeconds: asSeconds(record.nowSeconds),
        entropy: typeof record.entropy === "string" ? record.entropy : undefined,
      }),
    );
  }
  if (action === "archive") {
    return mapResult(
      chat.archiveBot({
        owner,
        botId: typeof record.botId === "string" ? record.botId : "",
        nowSeconds: asSeconds(record.nowSeconds),
      }),
    );
  }
  if (action === "join") {
    return mapResult(
      chat.joinBot({
        owner,
        botId: typeof record.botId === "string" ? record.botId : "",
        nowSeconds: asSeconds(record.nowSeconds),
      }),
    );
  }
  if (action === "post") {
    return mapResult(
      chat.post({
        owner,
        botId: typeof record.botId === "string" ? record.botId : "",
        body: typeof record.body === "string" ? record.body : "",
        nowSeconds: asSeconds(record.nowSeconds),
        entropy: typeof record.entropy === "string" ? record.entropy : undefined,
      }),
    );
  }
  if (action === "read") {
    return readResult(
      chat.read({
        owner,
        botId: typeof record.botId === "string" ? record.botId : undefined,
      }),
    );
  }
  return { status: 400, body: { error: "Unknown action." } };
}

export function parseForumFile(value: unknown): StoreLoad {
  if (!value || typeof value !== "object") return { ok: false, reason: "store-unreadable" };
  const record = value as Record<string, unknown>;
  if (record.v !== FORUM_FILE_V) {
    if (typeof record.v === "number") return { ok: false, reason: "unknown-version" };
    return { ok: false, reason: "store-unreadable" };
  }
  if (
    !Array.isArray(record.channels) ||
    !Array.isArray(record.bots) ||
    !Array.isArray(record.memberships) ||
    !Array.isArray(record.messages)
  ) {
    return { ok: false, reason: "store-unreadable" };
  }
  const channels: ForumChannel[] = [];
  for (const row of record.channels) {
    const channel = asChannel(row);
    if (!channel) return { ok: false, reason: "store-unreadable" };
    channels.push(channel);
  }
  const bots: ForumBot[] = [];
  for (const row of record.bots) {
    const bot = asBot(row);
    if (!bot) return { ok: false, reason: "store-unreadable" };
    bots.push(bot);
  }
  const memberships: ForumMembership[] = [];
  for (const row of record.memberships) {
    const membership = asMembership(row);
    if (!membership) return { ok: false, reason: "store-unreadable" };
    memberships.push(membership);
  }
  const messages: ForumMessage[] = [];
  for (const row of record.messages) {
    const message = asMessage(row);
    if (!message) return { ok: false, reason: "store-unreadable" };
    messages.push(message);
  }
  const file: ForumFile = {
    v: FORUM_FILE_V,
    channels,
    bots,
    memberships,
    messages,
  };
  if (!fileIsConsistent(file)) return { ok: false, reason: "store-unreadable" };
  return { ok: true, file };
}

function fileIsConsistent(file: ForumFile): boolean {
  const channelIds = new Set<string>();
  const owners = new Set<string>();
  for (const channel of file.channels) {
    if (owners.has(channel.owner) || channelIds.has(channel.id)) return false;
    owners.add(channel.owner);
    channelIds.add(channel.id);
  }
  const botIds = new Set<string>();
  const labels = new Set<string>();
  for (const bot of file.bots) {
    if (botIds.has(bot.id)) return false;
    const labelKey = `${bot.owner}\n${bot.label}`;
    if (labels.has(labelKey)) return false;
    labels.add(labelKey);
    botIds.add(bot.id);
    if (!bot.id.startsWith(`s3rch:bot:${bot.owner}:`)) return false;
  }
  const membershipKeys = new Set<string>();
  for (const membership of file.memberships) {
    const key = `${membership.channel}\n${membership.bot}`;
    if (membershipKeys.has(key)) return false;
    membershipKeys.add(key);
    const channel = file.channels.find((row) => row.id === membership.channel);
    const bot = file.bots.find((row) => row.id === membership.bot);
    if (!channel || !bot) return false;
    if (channel.owner !== membership.owner || bot.owner !== membership.owner) return false;
  }
  const messageIds = new Set<string>();
  for (const message of file.messages) {
    if (messageIds.has(message.id)) return false;
    messageIds.add(message.id);
    const channel = file.channels.find((row) => row.id === message.channel);
    if (!channel || channel.owner !== message.owner) return false;
    if (!file.bots.some((row) => row.id === message.bot && row.owner === message.owner)) {
      return false;
    }
  }
  return true;
}

function asChannel(value: unknown): ForumChannel | null {
  if (!isRecord(value)) return null;
  const owner = checksumOwner(value.owner);
  if (!owner || value.id !== channelIdFor(owner)) return null;
  if (!isProtocolV(value.v) || !isTime(value.created)) return null;
  return { id: channelIdFor(owner), owner, created: value.created, v: FORUM_FILE_V };
}

function asBot(value: unknown): ForumBot | null {
  if (!isRecord(value)) return null;
  const owner = checksumOwner(value.owner);
  const label = typeof value.label === "string" ? cleanLabel(value.label) : null;
  if (!owner || !label || value.label !== label) return null;
  if (value.kind !== "bot" && value.kind !== "cloud-agent") return null;
  if (value.status !== "active" && value.status !== "archived") return null;
  if (typeof value.id !== "string" || !value.id.startsWith(`s3rch:bot:${owner}:`)) return null;
  const suffix = value.id.slice(`s3rch:bot:${owner}:`.length);
  if (!/^[a-z0-9]+$/.test(suffix)) return null;
  if (!isProtocolV(value.v) || !isTime(value.created)) return null;
  const archivedAt = value.archivedAt;
  if (value.status === "active") {
    if (archivedAt !== null) return null;
  } else if (!isTime(archivedAt)) {
    return null;
  }
  return {
    id: value.id,
    owner,
    label,
    kind: value.kind,
    status: value.status,
    created: value.created,
    archivedAt: value.status === "active" ? null : (archivedAt as number),
    v: FORUM_FILE_V,
  };
}

function asMembership(value: unknown): ForumMembership | null {
  if (!isRecord(value)) return null;
  const owner = checksumOwner(value.owner);
  if (!owner || typeof value.channel !== "string" || typeof value.bot !== "string") return null;
  if (!isTime(value.joined)) return null;
  return { channel: value.channel, bot: value.bot, owner, joined: value.joined };
}

function asMessage(value: unknown): ForumMessage | null {
  if (!isRecord(value)) return null;
  const owner = checksumOwner(value.owner);
  if (!owner || typeof value.id !== "string" || !value.id.trim()) return null;
  if (typeof value.channel !== "string" || typeof value.bot !== "string") return null;
  if (typeof value.body !== "string" || !value.body.trim() || value.body.length > CHAT_BODY_MAX) {
    return null;
  }
  if (!isProtocolV(value.v) || !isTime(value.ts)) return null;
  return {
    id: value.id,
    channel: value.channel,
    owner,
    bot: value.bot,
    body: value.body,
    ts: value.ts,
    v: FORUM_FILE_V,
  };
}

function createBot(
  file: ForumFile,
  owner: string,
  label: string,
  kind: ForumActorKind,
  now: number,
  entropy: string,
): ForumBot | null {
  const id = `s3rch:bot:${owner}:${entropy}`;
  if (file.bots.some((row) => row.id === id)) return null;
  const bot: ForumBot = {
    id,
    owner,
    label,
    kind,
    status: "active",
    created: now,
    archivedAt: null,
    v: FORUM_FILE_V,
  };
  file.bots.push(bot);
  return bot;
}

function ensureChannel(file: ForumFile, owner: string, now: number): ForumChannel {
  const found = file.channels.find((row) => row.owner === owner);
  if (found) return found;
  const channel: ForumChannel = {
    id: channelIdFor(owner),
    owner,
    created: now,
    v: FORUM_FILE_V,
  };
  file.channels.push(channel);
  return channel;
}

function channelIdFor(owner: string): string {
  return `s3rch:forum:${owner}`;
}

function botForOwner(file: ForumFile, owner: string, botId: string): ForumBot | undefined {
  return file.bots.find((row) => row.id === botId && row.owner === owner);
}

function isMember(file: ForumFile, channel: string, botId: string): boolean {
  return file.memberships.some((row) => row.channel === channel && row.bot === botId);
}

function toView(file: ForumFile, bot: ForumBot): ForumBotView {
  const channel = file.channels.find((row) => row.owner === bot.owner);
  return {
    ...bot,
    member: channel ? isMember(file, channel.id, bot.id) : false,
  };
}

function checksumOwner(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return getAddress(value.trim());
  } catch {
    return null;
  }
}

function cleanLabel(value: string): string | null {
  const label = value.trim();
  if (!label || label.length > FORUM_LABEL_MAX) return null;
  if (/[\u0000-\u001f]/.test(label)) return null;
  return label;
}

function cleanEntropy(value: string | undefined): string | null {
  const entropy = (value ?? shortEntropy()).trim().toLowerCase();
  if (!/^[a-z0-9]+$/.test(entropy)) return null;
  return entropy;
}

function shortEntropy(bytes = 4): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

function nowSeconds(value: number | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  return Math.floor(Date.now() / 1000);
}

function isActorKind(value: unknown): value is ForumActorKind {
  return value === "bot" || value === "cloud-agent";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isProtocolV(value: unknown): boolean {
  return value === undefined || value === FORUM_FILE_V;
}

function asSeconds(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function mapResult(result: Denied | object): ForumHttpResult {
  if ("denied" in result && result.denied) {
    const reason = result.reason;
    const status =
      reason === "store-unreadable" || reason === "unknown-version"
        ? 500
        : reason === "bad-owner" ||
            reason === "bad-label" ||
            reason === "bad-kind" ||
            reason === "bad-body" ||
            reason === "bad-entropy"
          ? 400
          : 403;
    return { status, body: { denied: true, reason } };
  }
  return { status: 200, body: result as Record<string, unknown> };
}

function readResult(result: ReadChatResult): ForumHttpResult {
  return mapResult(result);
}
