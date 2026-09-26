/**
 * Renter-scoped chat for bots and cloud agents.
 *
 * The channel belongs to the renter (the checksummed SIWE address), not to
 * a process. Bot identity is a row in the ledger. Restart looks the row up
 * again. Copy mints a new id and does not join the channel. Archive keeps
 * the row and the messages.
 *
 * The ledger is a JSON file, same disk class as the seeder snapshot: a new
 * process can read it. It is not Gun room chat and not a second API key.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getAddress } from "viem";
import { CHAT_BODY_MAX } from "./chat";

export const RENTER_CHAT_FILE_V = 1;
export const RENTER_CHAT_LABEL_MAX = 40;

export type RenterActorKind = "bot" | "cloud-agent";
export type RenterBotStatus = "active" | "archived";

export type RenterChannel = {
  id: string;
  renter: string;
  created: number;
  v: number;
};

export type RenterBot = {
  id: string;
  renter: string;
  label: string;
  kind: RenterActorKind;
  status: RenterBotStatus;
  created: number;
  archivedAt: number | null;
  v: number;
};

export type RenterMembership = {
  channel: string;
  bot: string;
  renter: string;
  joined: number;
};

export type RenterChatMessage = {
  id: string;
  channel: string;
  renter: string;
  bot: string;
  body: string;
  ts: number;
  v: number;
};

export type RenterBotView = RenterBot & { member: boolean };

export type RenterChatFile = {
  v: typeof RENTER_CHAT_FILE_V;
  channels: RenterChannel[];
  bots: RenterBot[];
  memberships: RenterMembership[];
  messages: RenterChatMessage[];
};

export type StoreLoad =
  | { ok: true; file: RenterChatFile }
  | { ok: false; reason: "store-unreadable" | "unknown-version" };

export type RenterChatStore = {
  load(): StoreLoad;
  save(file: RenterChatFile): void;
};

export type Denied = { denied: true; reason: string };

export type RegisterBotInput = {
  renter: string;
  label: string;
  kind?: RenterActorKind;
  nowSeconds?: number;
  entropy?: string;
};

export type CopyBotInput = {
  renter: string;
  botId: string;
  label: string;
  nowSeconds?: number;
  entropy?: string;
};

export type BotRefInput = {
  renter: string;
  botId: string;
  nowSeconds?: number;
};

export type PostBotInput = {
  renter: string;
  botId: string;
  body: string;
  nowSeconds?: number;
  entropy?: string;
};

export type ReadChatInput = {
  renter: string;
  /** When set, the bot must already be a member. Omit for the renter account. */
  botId?: string;
};

export type RegisterBotResult =
  | Denied
  | { bot: RenterBotView; channel: RenterChannel };

export type CopyBotResult = Denied | { bot: RenterBotView; channel: RenterChannel };

export type ArchiveBotResult = Denied | { bot: RenterBotView };

export type JoinBotResult =
  | Denied
  | { bot: RenterBotView; channel: RenterChannel };

export type PostBotResult = Denied | { message: RenterChatMessage };

export type ReadChatResult =
  | Denied
  | {
      channel: RenterChannel | null;
      messages: RenterChatMessage[];
      bots: RenterBotView[];
    };

export type RenterChat = {
  registerBot(input: RegisterBotInput): RegisterBotResult;
  copyBot(input: CopyBotInput): CopyBotResult;
  archiveBot(input: BotRefInput): ArchiveBotResult;
  joinBot(input: BotRefInput): JoinBotResult;
  post(input: PostBotInput): PostBotResult;
  read(input: ReadChatInput): ReadChatResult;
};

type GlobalRenter = typeof globalThis & {
  __s3rchRenterChat?: RenterChat;
};

export function renterChatFilePath(): string {
  return process.env.S3RCH_RENTER_CHAT || `${process.cwd()}/data/renter-chat.json`;
}

export function emptyRenterChatFile(): RenterChatFile {
  return {
    v: RENTER_CHAT_FILE_V,
    channels: [],
    bots: [],
    memberships: [],
    messages: [],
  };
}

export class FileRenterChatStore implements RenterChatStore {
  constructor(private readonly filePath: string) {}

  load(): StoreLoad {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { ok: true, file: emptyRenterChatFile() };
      return { ok: false, reason: "store-unreadable" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return { ok: false, reason: "store-unreadable" };
    }
    return parseRenterChatFile(parsed);
  }

  save(file: RenterChatFile): void {
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(file), "utf8");
    renameSync(tmp, this.filePath);
  }
}

export function getRenterChatNetwork(): RenterChat {
  const g = globalThis as GlobalRenter;
  if (!g.__s3rchRenterChat) {
    g.__s3rchRenterChat = openRenterChat(new FileRenterChatStore(renterChatFilePath()));
  }
  return g.__s3rchRenterChat;
}

export function openRenterChat(store: RenterChatStore): RenterChat {
  function load(): { ok: true; file: RenterChatFile } | Denied {
    let loaded: StoreLoad;
    try {
      loaded = store.load();
    } catch {
      return { denied: true, reason: "store-unreadable" };
    }
    if (!loaded.ok) return { denied: true, reason: loaded.reason };
    return { ok: true, file: loaded.file };
  }

  function commit(file: RenterChatFile): Denied | null {
    try {
      store.save(file);
      return null;
    } catch {
      return { denied: true, reason: "store-unreadable" };
    }
  }

  function registerBot(input: RegisterBotInput): RegisterBotResult {
    const renter = checksumRenter(input.renter);
    if (!renter) return { denied: true, reason: "bad-renter" };
    const label = cleanLabel(input.label);
    if (!label) return { denied: true, reason: "bad-label" };
    if (input.kind !== undefined && !isActorKind(input.kind)) {
      return { denied: true, reason: "bad-kind" };
    }
    const kind = input.kind ?? "bot";
    const opened = load();
    if ("denied" in opened) return opened;
    const file = opened.file;
    const existing = file.bots.find((row) => row.renter === renter && row.label === label);
    const now = nowSeconds(input.nowSeconds);
    if (existing) {
      if (input.kind !== undefined && existing.kind !== kind) {
        return { denied: true, reason: "kind-mismatch" };
      }
      const hadChannel = file.channels.some((row) => row.renter === renter);
      const channel = ensureChannel(file, renter, now);
      if (!hadChannel) {
        const saved = commit(file);
        if (saved) return saved;
      }
      return { bot: toView(file, existing), channel };
    }
    const entropy = cleanEntropy(input.entropy);
    if (!entropy) return { denied: true, reason: "bad-entropy" };
    const channel = ensureChannel(file, renter, now);
    const bot = createBot(file, renter, label, kind, now, entropy);
    if (!bot) return { denied: true, reason: "bad-entropy" };
    file.memberships.push({
      channel: channel.id,
      bot: bot.id,
      renter,
      joined: now,
    });
    const saved = commit(file);
    if (saved) return saved;
    return { bot: toView(file, bot), channel };
  }

  function copyBot(input: CopyBotInput): CopyBotResult {
    const renter = checksumRenter(input.renter);
    if (!renter) return { denied: true, reason: "bad-renter" };
    const label = cleanLabel(input.label);
    if (!label) return { denied: true, reason: "bad-label" };
    const opened = load();
    if ("denied" in opened) return opened;
    const file = opened.file;
    const source = botForRenter(file, renter, input.botId);
    if (!source) return { denied: true, reason: "unknown-bot" };
    if (file.bots.some((row) => row.renter === renter && row.label === label)) {
      return { denied: true, reason: "label-taken" };
    }
    const entropy = cleanEntropy(input.entropy);
    if (!entropy) return { denied: true, reason: "bad-entropy" };
    const now = nowSeconds(input.nowSeconds);
    const channel = ensureChannel(file, renter, now);
    const bot = createBot(file, renter, label, source.kind, now, entropy);
    if (!bot) return { denied: true, reason: "bad-entropy" };
    const saved = commit(file);
    if (saved) return saved;
    return { bot: toView(file, bot), channel };
  }

  function archiveBot(input: BotRefInput): ArchiveBotResult {
    const renter = checksumRenter(input.renter);
    if (!renter) return { denied: true, reason: "bad-renter" };
    const opened = load();
    if ("denied" in opened) return opened;
    const file = opened.file;
    const bot = botForRenter(file, renter, input.botId);
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
    const renter = checksumRenter(input.renter);
    if (!renter) return { denied: true, reason: "bad-renter" };
    const opened = load();
    if ("denied" in opened) return opened;
    const file = opened.file;
    const bot = botForRenter(file, renter, input.botId);
    if (!bot) return { denied: true, reason: "unknown-bot" };
    if (bot.status !== "active") return { denied: true, reason: "archived" };
    const now = nowSeconds(input.nowSeconds);
    const channel = ensureChannel(file, renter, now);
    if (!isMember(file, channel.id, bot.id)) {
      file.memberships.push({
        channel: channel.id,
        bot: bot.id,
        renter,
        joined: now,
      });
      const saved = commit(file);
      if (saved) return saved;
    }
    return { bot: toView(file, bot), channel };
  }

  function post(input: PostBotInput): PostBotResult {
    const renter = checksumRenter(input.renter);
    if (!renter) return { denied: true, reason: "bad-renter" };
    const body = input.body.trim();
    if (!body || body.length > CHAT_BODY_MAX) return { denied: true, reason: "bad-body" };
    const opened = load();
    if ("denied" in opened) return opened;
    const file = opened.file;
    const bot = botForRenter(file, renter, input.botId);
    if (!bot) return { denied: true, reason: "unknown-bot" };
    if (bot.status !== "active") return { denied: true, reason: "archived" };
    const channel = file.channels.find((row) => row.renter === renter);
    if (!channel || !isMember(file, channel.id, bot.id)) {
      return { denied: true, reason: "not-member" };
    }
    const entropy = cleanEntropy(input.entropy);
    if (!entropy) return { denied: true, reason: "bad-entropy" };
    const ts = nowSeconds(input.nowSeconds);
    const id = `s3rch:renter-chat-msg:${renter}:${ts}:${entropy}`;
    if (file.messages.some((row) => row.id === id)) {
      return { denied: true, reason: "bad-entropy" };
    }
    const message: RenterChatMessage = {
      id,
      channel: channel.id,
      renter,
      bot: bot.id,
      body,
      ts,
      v: RENTER_CHAT_FILE_V,
    };
    file.messages.push(message);
    const saved = commit(file);
    if (saved) return saved;
    return { message };
  }

  function read(input: ReadChatInput): ReadChatResult {
    const renter = checksumRenter(input.renter);
    if (!renter) return { denied: true, reason: "bad-renter" };
    const opened = load();
    if ("denied" in opened) return opened;
    const file = opened.file;
    const channel = file.channels.find((row) => row.renter === renter) ?? null;
    if (input.botId !== undefined) {
      const bot = botForRenter(file, renter, input.botId);
      if (!bot) return { denied: true, reason: "unknown-bot" };
      if (!channel || !isMember(file, channel.id, bot.id)) {
        return { denied: true, reason: "not-member" };
      }
    }
    const messages = file.messages
      .filter((row) => row.renter === renter && (!channel || row.channel === channel.id))
      .slice()
      .sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
    const bots = file.bots
      .filter((row) => row.renter === renter)
      .map((row) => toView(file, row))
      .sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
    return { channel, messages, bots };
  }

  return { registerBot, copyBot, archiveBot, joinBot, post, read };
}

export type RenterChatHttpResult = {
  status: number;
  body: Record<string, unknown>;
};

export function handleRenterChatGet(
  chat: RenterChat,
  renter: string,
): RenterChatHttpResult {
  return readResult(chat.read({ renter }));
}

export function handleRenterChatPost(
  chat: RenterChat,
  renter: string,
  input: unknown,
): RenterChatHttpResult {
  if (!input || typeof input !== "object") {
    return { status: 400, body: { error: "Expected JSON." } };
  }
  const record = input as Record<string, unknown>;
  const action = record.action;
  if (action === "register") {
    return mapResult(
      chat.registerBot({
        renter,
        label: typeof record.label === "string" ? record.label : "",
        kind: record.kind as RenterActorKind | undefined,
        nowSeconds: asSeconds(record.nowSeconds),
        entropy: typeof record.entropy === "string" ? record.entropy : undefined,
      }),
    );
  }
  if (action === "copy") {
    return mapResult(
      chat.copyBot({
        renter,
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
        renter,
        botId: typeof record.botId === "string" ? record.botId : "",
        nowSeconds: asSeconds(record.nowSeconds),
      }),
    );
  }
  if (action === "join") {
    return mapResult(
      chat.joinBot({
        renter,
        botId: typeof record.botId === "string" ? record.botId : "",
        nowSeconds: asSeconds(record.nowSeconds),
      }),
    );
  }
  if (action === "post") {
    return mapResult(
      chat.post({
        renter,
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
        renter,
        botId: typeof record.botId === "string" ? record.botId : undefined,
      }),
    );
  }
  return { status: 400, body: { error: "Unknown action." } };
}

export function parseRenterChatFile(value: unknown): StoreLoad {
  if (!value || typeof value !== "object") return { ok: false, reason: "store-unreadable" };
  const record = value as Record<string, unknown>;
  if (record.v !== RENTER_CHAT_FILE_V) {
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
  const channels: RenterChannel[] = [];
  for (const row of record.channels) {
    const channel = asChannel(row);
    if (!channel) return { ok: false, reason: "store-unreadable" };
    channels.push(channel);
  }
  const bots: RenterBot[] = [];
  for (const row of record.bots) {
    const bot = asBot(row);
    if (!bot) return { ok: false, reason: "store-unreadable" };
    bots.push(bot);
  }
  const memberships: RenterMembership[] = [];
  for (const row of record.memberships) {
    const membership = asMembership(row);
    if (!membership) return { ok: false, reason: "store-unreadable" };
    memberships.push(membership);
  }
  const messages: RenterChatMessage[] = [];
  for (const row of record.messages) {
    const message = asMessage(row);
    if (!message) return { ok: false, reason: "store-unreadable" };
    messages.push(message);
  }
  const file: RenterChatFile = {
    v: RENTER_CHAT_FILE_V,
    channels,
    bots,
    memberships,
    messages,
  };
  if (!fileIsConsistent(file)) return { ok: false, reason: "store-unreadable" };
  return { ok: true, file };
}

function fileIsConsistent(file: RenterChatFile): boolean {
  const channelIds = new Set<string>();
  const renters = new Set<string>();
  for (const channel of file.channels) {
    if (renters.has(channel.renter) || channelIds.has(channel.id)) return false;
    renters.add(channel.renter);
    channelIds.add(channel.id);
  }
  const botIds = new Set<string>();
  const labels = new Set<string>();
  for (const bot of file.bots) {
    if (botIds.has(bot.id)) return false;
    const labelKey = `${bot.renter}\n${bot.label}`;
    if (labels.has(labelKey)) return false;
    labels.add(labelKey);
    botIds.add(bot.id);
    if (!bot.id.startsWith(`s3rch:bot:${bot.renter}:`)) return false;
  }
  const membershipKeys = new Set<string>();
  for (const membership of file.memberships) {
    const key = `${membership.channel}\n${membership.bot}`;
    if (membershipKeys.has(key)) return false;
    membershipKeys.add(key);
    const channel = file.channels.find((row) => row.id === membership.channel);
    const bot = file.bots.find((row) => row.id === membership.bot);
    if (!channel || !bot) return false;
    if (channel.renter !== membership.renter || bot.renter !== membership.renter) return false;
  }
  const messageIds = new Set<string>();
  for (const message of file.messages) {
    if (messageIds.has(message.id)) return false;
    messageIds.add(message.id);
    const channel = file.channels.find((row) => row.id === message.channel);
    if (!channel || channel.renter !== message.renter) return false;
    if (!file.bots.some((row) => row.id === message.bot && row.renter === message.renter)) {
      return false;
    }
  }
  return true;
}

function asChannel(value: unknown): RenterChannel | null {
  if (!isRecord(value)) return null;
  const renter = checksumRenter(value.renter);
  if (!renter || value.id !== channelIdFor(renter)) return null;
  if (!isProtocolV(value.v) || !isTime(value.created)) return null;
  return { id: channelIdFor(renter), renter, created: value.created, v: RENTER_CHAT_FILE_V };
}

function asBot(value: unknown): RenterBot | null {
  if (!isRecord(value)) return null;
  const renter = checksumRenter(value.renter);
  const label = typeof value.label === "string" ? cleanLabel(value.label) : null;
  if (!renter || !label || value.label !== label) return null;
  if (value.kind !== "bot" && value.kind !== "cloud-agent") return null;
  if (value.status !== "active" && value.status !== "archived") return null;
  if (typeof value.id !== "string" || !value.id.startsWith(`s3rch:bot:${renter}:`)) return null;
  const suffix = value.id.slice(`s3rch:bot:${renter}:`.length);
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
    renter,
    label,
    kind: value.kind,
    status: value.status,
    created: value.created,
    archivedAt: value.status === "active" ? null : (archivedAt as number),
    v: RENTER_CHAT_FILE_V,
  };
}

function asMembership(value: unknown): RenterMembership | null {
  if (!isRecord(value)) return null;
  const renter = checksumRenter(value.renter);
  if (!renter || typeof value.channel !== "string" || typeof value.bot !== "string") return null;
  if (!isTime(value.joined)) return null;
  return { channel: value.channel, bot: value.bot, renter, joined: value.joined };
}

function asMessage(value: unknown): RenterChatMessage | null {
  if (!isRecord(value)) return null;
  const renter = checksumRenter(value.renter);
  if (!renter || typeof value.id !== "string" || !value.id.trim()) return null;
  if (typeof value.channel !== "string" || typeof value.bot !== "string") return null;
  if (typeof value.body !== "string" || !value.body.trim() || value.body.length > CHAT_BODY_MAX) {
    return null;
  }
  if (!isProtocolV(value.v) || !isTime(value.ts)) return null;
  return {
    id: value.id,
    channel: value.channel,
    renter,
    bot: value.bot,
    body: value.body,
    ts: value.ts,
    v: RENTER_CHAT_FILE_V,
  };
}

function createBot(
  file: RenterChatFile,
  renter: string,
  label: string,
  kind: RenterActorKind,
  now: number,
  entropy: string,
): RenterBot | null {
  const id = `s3rch:bot:${renter}:${entropy}`;
  if (file.bots.some((row) => row.id === id)) return null;
  const bot: RenterBot = {
    id,
    renter,
    label,
    kind,
    status: "active",
    created: now,
    archivedAt: null,
    v: RENTER_CHAT_FILE_V,
  };
  file.bots.push(bot);
  return bot;
}

function ensureChannel(file: RenterChatFile, renter: string, now: number): RenterChannel {
  const found = file.channels.find((row) => row.renter === renter);
  if (found) return found;
  const channel: RenterChannel = {
    id: channelIdFor(renter),
    renter,
    created: now,
    v: RENTER_CHAT_FILE_V,
  };
  file.channels.push(channel);
  return channel;
}

function channelIdFor(renter: string): string {
  return `s3rch:renter-chat:${renter}`;
}

function botForRenter(file: RenterChatFile, renter: string, botId: string): RenterBot | undefined {
  return file.bots.find((row) => row.id === botId && row.renter === renter);
}

function isMember(file: RenterChatFile, channel: string, botId: string): boolean {
  return file.memberships.some((row) => row.channel === channel && row.bot === botId);
}

function toView(file: RenterChatFile, bot: RenterBot): RenterBotView {
  const channel = file.channels.find((row) => row.renter === bot.renter);
  return {
    ...bot,
    member: channel ? isMember(file, channel.id, bot.id) : false,
  };
}

function checksumRenter(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return getAddress(value.trim());
  } catch {
    return null;
  }
}

function cleanLabel(value: string): string | null {
  const label = value.trim();
  if (!label || label.length > RENTER_CHAT_LABEL_MAX) return null;
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

function isActorKind(value: unknown): value is RenterActorKind {
  return value === "bot" || value === "cloud-agent";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isProtocolV(value: unknown): boolean {
  return value === undefined || value === RENTER_CHAT_FILE_V;
}

function asSeconds(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function mapResult(result: Denied | object): RenterChatHttpResult {
  if ("denied" in result && result.denied) {
    const reason = result.reason;
    const status =
      reason === "store-unreadable" || reason === "unknown-version"
        ? 500
        : reason === "bad-renter" ||
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

function readResult(result: ReadChatResult): RenterChatHttpResult {
  return mapResult(result);
}
