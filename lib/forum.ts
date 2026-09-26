/**
 * AI forum for humans, bots, and cloud agents.
 *
 * A signed-in owner (SIWE address) gets one forum channel. Bots and agents
 * are rows in that ledger. Restart looks the row up again. Copy mints a new
 * id and does not join. Archive keeps the row and the messages.
 *
 * The channel still has one owner. Invites and groups are membership, not
 * co-ownership. A renter with no invite sees nothing. Bots act under their
 * human owner's membership.
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

export type ForumInvite = {
  channel: string;
  guest: string;
  created: number;
};

export type ForumGroup = {
  id: string;
  owner: string;
  channel: string;
  label: string;
  created: number;
};

export type ForumGroupMember = {
  group: string;
  member: string;
  joined: number;
};

export const FORUM_THINKING_KINDS = [
  "type",
  "mouse",
  "mcp",
  "focus",
  "prompt",
  "file",
  "secret",
] as const;

export type ForumThinkingKind = (typeof FORUM_THINKING_KINDS)[number];

export type ForumThinking = {
  kind: ForumThinkingKind;
  text: string;
};

export type ForumSnapshot = {
  handle: string;
  mime: "image/png";
  seq: number;
};

/** Latest visor desktop for one channel. Handles only. Image bytes are not here. */
export type ForumDesktop = {
  channel: string;
  session: string;
  snapshot: ForumSnapshot | null;
  thinking: ForumThinking[];
  files: { handle: string }[];
  secrets: { handle: string }[];
  updated: number;
};

export type PublishDesktopInput = {
  owner: string;
  session: string;
  snapshot: ForumSnapshot | null;
  /** Held in process memory for this channel. Never written to the JSON file. */
  pngBase64?: string;
  thinking: ForumThinking[];
  files: { handle: string }[];
  secrets: { handle: string }[];
  nowSeconds?: number;
};

export type PublishDesktopResult = Denied | { desktop: ForumDesktop };

export type ForumSnapshotBytes = {
  mime: "image/png";
  bytes: Buffer;
};

export type ForumBotView = ForumBot & { member: boolean };

export type ForumFile = {
  v: typeof FORUM_FILE_V;
  channels: ForumChannel[];
  bots: ForumBot[];
  memberships: ForumMembership[];
  messages: ForumMessage[];
  invites: ForumInvite[];
  groups: ForumGroup[];
  groupMembers: ForumGroupMember[];
  desktops: ForumDesktop[];
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
  /** Channel id. Omit to post on the caller's own channel. */
  channel?: string;
};

export type InviteInput = {
  owner: string;
  guest: string;
  nowSeconds?: number;
};

export type GroupInput = {
  owner: string;
  label: string;
  nowSeconds?: number;
  entropy?: string;
};

export type GroupMemberInput = {
  owner: string;
  groupId: string;
  member: string;
  nowSeconds?: number;
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

export type ForumShared = {
  channel: ForumChannel;
  messages: ForumMessage[];
  desktop: ForumDesktop | null;
};

export type ReadChatResult =
  | Denied
  | {
      channel: ForumChannel | null;
      messages: ForumMessage[];
      bots: ForumBotView[];
      desktop: ForumDesktop | null;
      shared: ForumShared[];
    };

export type InviteResult = Denied | { invite: ForumInvite; channel: ForumChannel };

export type UninviteResult = Denied | { channel: ForumChannel; guest: string; removed: boolean };

export type GroupResult = Denied | { group: ForumGroup; channel: ForumChannel };

export type GroupMemberResult = Denied | { group: ForumGroup; member: string; removed?: boolean };

export type Forum = {
  registerBot(input: RegisterBotInput): RegisterBotResult;
  copyBot(input: CopyBotInput): CopyBotResult;
  archiveBot(input: BotRefInput): ArchiveBotResult;
  joinBot(input: BotRefInput): JoinBotResult;
  post(input: PostBotInput): PostBotResult;
  read(input: ReadChatInput): ReadChatResult;
  invite(input: InviteInput): InviteResult;
  uninvite(input: InviteInput): UninviteResult;
  createGroup(input: GroupInput): GroupResult;
  addGroupMember(input: GroupMemberInput): GroupMemberResult;
  removeGroupMember(input: GroupMemberInput): GroupMemberResult;
  publishDesktop(input: PublishDesktopInput): PublishDesktopResult;
  readSnapshot(input: { owner: string; handle: string }): ForumSnapshotBytes | null;
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
    invites: [],
    groups: [],
    groupMembers: [],
    desktops: [],
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
  const heldPng = new Map<string, { channel: string; bytes: Buffer }>();

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
    const home = file.channels.find((row) => row.owner === owner);
    const requested = typeof input.channel === "string" ? input.channel.trim() : "";
    let channel = home;
    if (requested) {
      channel = file.channels.find((row) => row.id === requested);
      if (!channel) return { denied: true, reason: "unknown-channel" };
      if (!canSee(file, owner, channel)) return { denied: true, reason: "not-invited" };
    }
    if (!channel || !home || !isMember(file, home.id, bot.id)) {
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
    const messages = messagesOn(file, channel?.id ?? null);
    const bots = file.bots
      .filter((row) => row.owner === owner)
      .map((row) => toView(file, row))
      .sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
    return {
      channel,
      messages,
      bots,
      desktop: desktopOn(file, channel?.id ?? null),
      shared: sharedFor(file, owner),
    };
  }

  function publishDesktop(input: PublishDesktopInput): PublishDesktopResult {
    const owner = checksumOwner(input.owner);
    if (!owner) return { denied: true, reason: "bad-owner" };
    const session = cleanSession(input.session);
    if (!session) return { denied: true, reason: "bad-desktop" };
    const thinking = cleanThinking(input.thinking);
    const files = cleanHandles(input.files);
    const secrets = cleanHandles(input.secrets);
    if (!thinking || !files || !secrets) return { denied: true, reason: "bad-desktop" };
    if (input.snapshot !== null && !isSnapshot(input.snapshot)) {
      return { denied: true, reason: "bad-snapshot" };
    }
    const opened = load();
    if ("denied" in opened) return opened;
    const file = opened.file;
    const now = nowSeconds(input.nowSeconds);
    const channel = ensureChannel(file, owner, now);
    let png: Buffer | null = null;
    if (input.pngBase64 !== undefined) {
      if (!input.snapshot) return { denied: true, reason: "bad-snapshot" };
      png = decodePng(input.pngBase64);
      if (!png) return { denied: true, reason: "bad-snapshot" };
    }
    const desktop: ForumDesktop = {
      channel: channel.id,
      session,
      snapshot: input.snapshot,
      thinking,
      files,
      secrets,
      updated: now,
    };
    file.desktops = file.desktops.filter((row) => row.channel !== channel.id);
    file.desktops.push(desktop);
    const saved = commit(file);
    if (saved) return saved;
    for (const [key, held] of heldPng) {
      if (held.channel === channel.id) heldPng.delete(key);
    }
    if (png && input.snapshot) {
      heldPng.set(heldKey(channel.id, input.snapshot.handle), {
        channel: channel.id,
        bytes: png,
      });
    }
    return { desktop };
  }

  function readSnapshot(input: { owner: string; handle: string }): ForumSnapshotBytes | null {
    const owner = checksumOwner(input.owner);
    const handle = cleanHandle(input.handle);
    if (!owner || !handle) return null;
    const opened = load();
    if ("denied" in opened) return null;
    const file = opened.file;
    const row = file.desktops.find((item) => item.snapshot?.handle === handle);
    if (!row?.snapshot) return null;
    const channel = file.channels.find((item) => item.id === row.channel);
    if (!channel || !canSee(file, owner, channel)) return null;
    const held = heldPng.get(heldKey(row.channel, handle));
    if (!held || held.channel !== row.channel) return null;
    return { mime: "image/png", bytes: held.bytes };
  }

  function invite(input: InviteInput): InviteResult {
    const owner = checksumOwner(input.owner);
    const guest = checksumOwner(input.guest);
    if (!owner) return { denied: true, reason: "bad-owner" };
    if (!guest || guest === owner) return { denied: true, reason: "bad-guest" };
    const opened = load();
    if ("denied" in opened) return opened;
    const file = opened.file;
    const now = nowSeconds(input.nowSeconds);
    const channel = ensureChannel(file, owner, now);
    const existing = file.invites.find((row) => row.channel === channel.id && row.guest === guest);
    if (existing) return { invite: existing, channel };
    const row: ForumInvite = { channel: channel.id, guest, created: now };
    file.invites.push(row);
    const saved = commit(file);
    if (saved) return saved;
    return { invite: row, channel };
  }

  function uninvite(input: InviteInput): UninviteResult {
    const owner = checksumOwner(input.owner);
    const guest = checksumOwner(input.guest);
    if (!owner) return { denied: true, reason: "bad-owner" };
    if (!guest || guest === owner) return { denied: true, reason: "bad-guest" };
    const opened = load();
    if ("denied" in opened) return opened;
    const file = opened.file;
    const channel = file.channels.find((row) => row.owner === owner);
    if (!channel) return { denied: true, reason: "unknown-channel" };
    const before = file.invites.length;
    file.invites = file.invites.filter((row) => !(row.channel === channel.id && row.guest === guest));
    const removed = file.invites.length !== before;
    if (removed) {
      const saved = commit(file);
      if (saved) return saved;
    }
    return { channel, guest, removed };
  }

  function createGroup(input: GroupInput): GroupResult {
    const owner = checksumOwner(input.owner);
    if (!owner) return { denied: true, reason: "bad-owner" };
    const label = cleanLabel(input.label);
    if (!label) return { denied: true, reason: "bad-label" };
    const opened = load();
    if ("denied" in opened) return opened;
    const file = opened.file;
    const now = nowSeconds(input.nowSeconds);
    const channel = ensureChannel(file, owner, now);
    const existing = file.groups.find((row) => row.owner === owner && row.label === label);
    if (existing) return { group: existing, channel };
    const entropy = cleanEntropy(input.entropy);
    if (!entropy) return { denied: true, reason: "bad-entropy" };
    const id = `s3rch:forum-group:${owner}:${entropy}`;
    if (file.groups.some((row) => row.id === id)) return { denied: true, reason: "bad-entropy" };
    const group: ForumGroup = { id, owner, channel: channel.id, label, created: now };
    file.groups.push(group);
    const saved = commit(file);
    if (saved) return saved;
    return { group, channel };
  }

  function addGroupMember(input: GroupMemberInput): GroupMemberResult {
    const owner = checksumOwner(input.owner);
    const member = checksumOwner(input.member);
    if (!owner) return { denied: true, reason: "bad-owner" };
    if (!member || member === owner) return { denied: true, reason: "bad-member" };
    const opened = load();
    if ("denied" in opened) return opened;
    const file = opened.file;
    const group = file.groups.find((row) => row.id === input.groupId && row.owner === owner);
    if (!group) return { denied: true, reason: "unknown-group" };
    if (file.groupMembers.some((row) => row.group === group.id && row.member === member)) {
      return { group, member };
    }
    file.groupMembers.push({
      group: group.id,
      member,
      joined: nowSeconds(input.nowSeconds),
    });
    const saved = commit(file);
    if (saved) return saved;
    return { group, member };
  }

  function removeGroupMember(input: GroupMemberInput): GroupMemberResult {
    const owner = checksumOwner(input.owner);
    const member = checksumOwner(input.member);
    if (!owner) return { denied: true, reason: "bad-owner" };
    if (!member || member === owner) return { denied: true, reason: "bad-member" };
    const opened = load();
    if ("denied" in opened) return opened;
    const file = opened.file;
    const group = file.groups.find((row) => row.id === input.groupId && row.owner === owner);
    if (!group) return { denied: true, reason: "unknown-group" };
    const before = file.groupMembers.length;
    file.groupMembers = file.groupMembers.filter(
      (row) => !(row.group === group.id && row.member === member),
    );
    const removed = file.groupMembers.length !== before;
    if (removed) {
      const saved = commit(file);
      if (saved) return saved;
    }
    return { group, member, removed };
  }

  return {
    registerBot,
    copyBot,
    archiveBot,
    joinBot,
    post,
    read,
    invite,
    uninvite,
    createGroup,
    addGroupMember,
    removeGroupMember,
    publishDesktop,
    readSnapshot,
  };
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
        channel: typeof record.channel === "string" ? record.channel : undefined,
      }),
    );
  }
  if (action === "invite") {
    return mapResult(
      chat.invite({
        owner,
        guest: typeof record.guest === "string" ? record.guest : "",
        nowSeconds: asSeconds(record.nowSeconds),
      }),
    );
  }
  if (action === "uninvite") {
    return mapResult(
      chat.uninvite({
        owner,
        guest: typeof record.guest === "string" ? record.guest : "",
        nowSeconds: asSeconds(record.nowSeconds),
      }),
    );
  }
  if (action === "group") {
    return mapResult(
      chat.createGroup({
        owner,
        label: typeof record.label === "string" ? record.label : "",
        nowSeconds: asSeconds(record.nowSeconds),
        entropy: typeof record.entropy === "string" ? record.entropy : undefined,
      }),
    );
  }
  if (action === "group-add") {
    return mapResult(
      chat.addGroupMember({
        owner,
        groupId: typeof record.groupId === "string" ? record.groupId : "",
        member: typeof record.member === "string" ? record.member : "",
        nowSeconds: asSeconds(record.nowSeconds),
      }),
    );
  }
  if (action === "group-remove") {
    return mapResult(
      chat.removeGroupMember({
        owner,
        groupId: typeof record.groupId === "string" ? record.groupId : "",
        member: typeof record.member === "string" ? record.member : "",
        nowSeconds: asSeconds(record.nowSeconds),
      }),
    );
  }
  if (action === "desktop") {
    const parsed = parseDesktopPost(record);
    if ("denied" in parsed) return { status: 400, body: parsed };
    return mapResult(chat.publishDesktop({ owner, ...parsed }));
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
  const inviteRows = record.invites === undefined ? [] : record.invites;
  const groupRows = record.groups === undefined ? [] : record.groups;
  const groupMemberRows = record.groupMembers === undefined ? [] : record.groupMembers;
  const desktopRows = record.desktops === undefined ? [] : record.desktops;
  if (
    !Array.isArray(inviteRows) ||
    !Array.isArray(groupRows) ||
    !Array.isArray(groupMemberRows) ||
    !Array.isArray(desktopRows)
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
  const invites: ForumInvite[] = [];
  for (const row of inviteRows) {
    const invite = asInvite(row);
    if (!invite) return { ok: false, reason: "store-unreadable" };
    invites.push(invite);
  }
  const groups: ForumGroup[] = [];
  for (const row of groupRows) {
    const group = asGroup(row);
    if (!group) return { ok: false, reason: "store-unreadable" };
    groups.push(group);
  }
  const groupMembers: ForumGroupMember[] = [];
  for (const row of groupMemberRows) {
    const member = asGroupMember(row);
    if (!member) return { ok: false, reason: "store-unreadable" };
    groupMembers.push(member);
  }
  const desktops: ForumDesktop[] = [];
  for (const row of desktopRows) {
    const desktop = asDesktop(row);
    if (!desktop) return { ok: false, reason: "store-unreadable" };
    desktops.push(desktop);
  }
  const file: ForumFile = {
    v: FORUM_FILE_V,
    channels,
    bots,
    memberships,
    messages,
    invites,
    groups,
    groupMembers,
    desktops,
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
    const bot = file.bots.find((row) => row.id === message.bot);
    if (!channel || !bot || bot.owner !== message.owner) return false;
  }
  const inviteKeys = new Set<string>();
  for (const invite of file.invites) {
    const key = `${invite.channel}\n${invite.guest}`;
    if (inviteKeys.has(key)) return false;
    inviteKeys.add(key);
    const channel = file.channels.find((row) => row.id === invite.channel);
    if (!channel || channel.owner === invite.guest) return false;
  }
  const groupIds = new Set<string>();
  const groupLabels = new Set<string>();
  for (const group of file.groups) {
    if (groupIds.has(group.id)) return false;
    groupIds.add(group.id);
    const labelKey = `${group.owner}\n${group.label}`;
    if (groupLabels.has(labelKey)) return false;
    groupLabels.add(labelKey);
    if (!group.id.startsWith(`s3rch:forum-group:${group.owner}:`)) return false;
    const channel = file.channels.find((row) => row.id === group.channel);
    if (!channel || channel.owner !== group.owner) return false;
  }
  const groupMemberKeys = new Set<string>();
  for (const member of file.groupMembers) {
    const key = `${member.group}\n${member.member}`;
    if (groupMemberKeys.has(key)) return false;
    groupMemberKeys.add(key);
    const group = file.groups.find((row) => row.id === member.group);
    if (!group || group.owner === member.member) return false;
  }
  const desktopChannels = new Set<string>();
  for (const desktop of file.desktops) {
    if (desktopChannels.has(desktop.channel)) return false;
    desktopChannels.add(desktop.channel);
    if (!file.channels.some((row) => row.id === desktop.channel)) return false;
    if (!cleanSession(desktop.session)) return false;
    if (desktop.snapshot && !isSnapshot(desktop.snapshot)) return false;
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

function asInvite(value: unknown): ForumInvite | null {
  if (!isRecord(value)) return null;
  const guest = checksumOwner(value.guest);
  if (!guest || typeof value.channel !== "string" || !isTime(value.created)) return null;
  return { channel: value.channel, guest, created: value.created };
}

function asGroup(value: unknown): ForumGroup | null {
  if (!isRecord(value)) return null;
  const owner = checksumOwner(value.owner);
  const label = typeof value.label === "string" ? cleanLabel(value.label) : null;
  if (!owner || !label || value.label !== label) return null;
  if (typeof value.id !== "string" || typeof value.channel !== "string") return null;
  if (!isTime(value.created)) return null;
  return { id: value.id, owner, channel: value.channel, label, created: value.created };
}

function asGroupMember(value: unknown): ForumGroupMember | null {
  if (!isRecord(value)) return null;
  const member = checksumOwner(value.member);
  if (!member || typeof value.group !== "string" || !isTime(value.joined)) return null;
  return { group: value.group, member, joined: value.joined };
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

function canSee(file: ForumFile, actor: string, channel: ForumChannel): boolean {
  if (channel.owner === actor) return true;
  if (file.invites.some((row) => row.channel === channel.id && row.guest === actor)) return true;
  return file.groupMembers.some((row) => {
    if (row.member !== actor) return false;
    const group = file.groups.find((item) => item.id === row.group);
    return group?.channel === channel.id;
  });
}

function messagesOn(file: ForumFile, channelId: string | null): ForumMessage[] {
  if (!channelId) return [];
  return file.messages
    .filter((row) => row.channel === channelId)
    .slice()
    .sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
}

function sharedFor(file: ForumFile, actor: string): ForumShared[] {
  return file.channels
    .filter((channel) => channel.owner !== actor && canSee(file, actor, channel))
    .map((channel) => ({
      channel,
      messages: messagesOn(file, channel.id),
      desktop: desktopOn(file, channel.id),
    }))
    .sort((a, b) => a.channel.id.localeCompare(b.channel.id));
}

function desktopOn(file: ForumFile, channelId: string | null): ForumDesktop | null {
  if (!channelId) return null;
  return file.desktops.find((row) => row.channel === channelId) ?? null;
}

function toView(file: ForumFile, bot: ForumBot): ForumBotView {
  const channel = file.channels.find((row) => row.owner === bot.owner);
  return {
    ...bot,
    member: channel ? isMember(file, channel.id, bot.id) : false,
  };
}

function heldKey(channel: string, handle: string): string {
  return `${channel}\n${handle}`;
}

function isThinkingKind(value: string): value is ForumThinkingKind {
  return (FORUM_THINKING_KINDS as readonly string[]).includes(value);
}

function cleanSession(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const session = value.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(session)) {
    return null;
  }
  return session;
}

function cleanHandle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const handle = value.trim();
  if (!handle || handle.length > 80) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(handle)) return null;
  return handle;
}

function cleanActivityText(value: string): string | null {
  const text = value.replace(/[\u0000-\u001f]/g, " ").trim();
  if (!text || text.length > 280) return null;
  if (text.includes("content_base64") || text.includes("data:image")) return null;
  return text;
}

function cleanThinking(value: unknown): ForumThinking[] | null {
  if (!Array.isArray(value) || value.length > 64) return null;
  const lines: ForumThinking[] = [];
  for (const row of value) {
    if (!isRecord(row)) return null;
    if ("value" in row || "bytes" in row || "content_base64" in row || "png_base64" in row) {
      return null;
    }
    if (typeof row.kind !== "string" || !isThinkingKind(row.kind)) return null;
    if (typeof row.text !== "string") return null;
    const text = cleanActivityText(row.text);
    if (!text) return null;
    lines.push({ kind: row.kind, text });
  }
  return lines;
}

function cleanHandles(value: unknown): { handle: string }[] | null {
  if (!Array.isArray(value) || value.length > 32) return null;
  const handles: { handle: string }[] = [];
  for (const row of value) {
    if (!isRecord(row)) return null;
    const handle = cleanHandle(row.handle);
    if (!handle) return null;
    handles.push({ handle });
  }
  return handles;
}

function isSnapshot(value: ForumSnapshot): boolean {
  return (
    value.mime === "image/png" &&
    cleanHandle(value.handle) === value.handle &&
    Number.isInteger(value.seq) &&
    value.seq >= 1 &&
    value.seq <= 1_000_000_000
  );
}

function asSnapshot(value: Record<string, unknown>): ForumSnapshot | null {
  const handle = cleanHandle(value.handle);
  if (!handle || value.mime !== "image/png") return null;
  if (typeof value.seq !== "number" || !Number.isInteger(value.seq)) return null;
  const snapshot: ForumSnapshot = { handle, mime: "image/png", seq: value.seq };
  return isSnapshot(snapshot) ? snapshot : null;
}

function asDesktop(value: unknown): ForumDesktop | null {
  if (!isRecord(value)) return null;
  if ("png_base64" in value || "bytes" in value || "value" in value || "content_base64" in value) {
    return null;
  }
  if (typeof value.channel !== "string" || !value.channel.startsWith("s3rch:forum:")) return null;
  const session = cleanSession(value.session);
  if (!session || !isTime(value.updated)) return null;
  let snapshot: ForumSnapshot | null = null;
  if (value.snapshot !== null) {
    if (!isRecord(value.snapshot)) return null;
    snapshot = asSnapshot(value.snapshot);
    if (!snapshot) return null;
  }
  const thinking = cleanThinking(value.thinking);
  const files = cleanHandles(value.files);
  const secrets = cleanHandles(value.secrets);
  if (!thinking || !files || !secrets) return null;
  return {
    channel: value.channel,
    session,
    snapshot,
    thinking,
    files,
    secrets,
    updated: value.updated,
  };
}

function decodePng(value: string): Buffer | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2_000_000) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return null;
  const bytes = Buffer.from(trimmed, "base64");
  if (bytes.length === 0 || bytes.length > 1_500_000) return null;
  return bytes;
}

function secretNeedles(record: Record<string, unknown>): string[] {
  const found: string[] = [];
  const walk = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    const row = value as Record<string, unknown>;
    if (typeof row.value === "string") found.push(row.value);
    if (typeof row.content_base64 === "string") {
      const text = Buffer.from(row.content_base64, "base64").toString("utf8");
      if (text && !text.includes("\u0000")) found.push(text);
    }
    for (const child of Object.values(row)) {
      if (child !== row.value && child !== row.content_base64) walk(child);
    }
  };
  walk(record.thinking);
  walk(record.files);
  walk(record.secrets);
  return found.filter((item) => item.length >= 4);
}

function scrub(text: string, needles: string[]): string {
  let out = text;
  for (const needle of needles) {
    if (needle.length >= 4 && out.includes(needle)) out = out.split(needle).join("***");
  }
  return out;
}

function parseDesktopPost(
  record: Record<string, unknown>,
): Omit<PublishDesktopInput, "owner"> | Denied {
  const thinkingRaw = record.thinking;
  if (!Array.isArray(thinkingRaw)) return { denied: true, reason: "bad-desktop" };
  const needles = secretNeedles(record);
  const thinking: ForumThinking[] = [];
  for (const row of thinkingRaw) {
    if (!isRecord(row) || typeof row.kind !== "string" || typeof row.text !== "string") {
      return { denied: true, reason: "bad-desktop" };
    }
    if (!isThinkingKind(row.kind)) return { denied: true, reason: "bad-desktop" };
    const text = cleanActivityText(scrub(row.text, needles));
    if (!text) return { denied: true, reason: "bad-desktop" };
    thinking.push({ kind: row.kind, text });
  }
  const files = cleanHandles(record.files);
  const secrets = cleanHandles(record.secrets);
  if (!files || !secrets) return { denied: true, reason: "bad-desktop" };
  let snapshot: ForumSnapshot | null = null;
  if (record.snapshot !== undefined && record.snapshot !== null) {
    if (!isRecord(record.snapshot)) return { denied: true, reason: "bad-snapshot" };
    const parsed = asSnapshot(record.snapshot);
    if (!parsed) return { denied: true, reason: "bad-snapshot" };
    snapshot = parsed;
  }
  let pngBase64: string | undefined;
  if (record.png_base64 !== undefined) {
    if (typeof record.png_base64 !== "string") return { denied: true, reason: "bad-snapshot" };
    pngBase64 = record.png_base64;
  }
  return {
    session: typeof record.session === "string" ? record.session : "",
    snapshot,
    pngBase64,
    thinking,
    files,
    secrets,
    nowSeconds: asSeconds(record.nowSeconds),
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
            reason === "bad-entropy" ||
            reason === "bad-guest" ||
            reason === "bad-member" ||
            reason === "bad-desktop" ||
            reason === "bad-snapshot"
          ? 400
          : 403;
    return { status, body: { denied: true, reason } };
  }
  return { status: 200, body: result as Record<string, unknown> };
}

function readResult(result: ReadChatResult): ForumHttpResult {
  return mapResult(result);
}
