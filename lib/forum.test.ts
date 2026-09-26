import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  FileForumStore,
  handleForumGet,
  handleForumPost,
  openForum,
  type Forum,
} from "./forum";

const ALICE = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const BOB = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const NOW = 1_700_000_000;

function tempFile(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "s3rch-forum-"));
  return { dir, file: join(dir, "forum.json") };
}

function openAt(file: string): Forum {
  return openForum(new FileForumStore(file));
}

describe("AI forum ledger", () => {
  it("a message posted by a bot is still there after a simulated restart", () => {
    const { dir, file } = tempFile();
    try {
      const first = openAt(file);
      const registered = first.registerBot({
        owner: ALICE.toLowerCase(),
        label: "ledger",
        nowSeconds: NOW,
        entropy: "aa11",
      });
      assert.ok(!("denied" in registered));
      assert.equal(registered.bot.member, true);
      assert.equal(registered.bot.owner, ALICE);
      const posted = first.post({
        owner: ALICE,
        botId: registered.bot.id,
        body: "  still here  ",
        nowSeconds: NOW + 1,
        entropy: "bb22",
      });
      assert.ok(!("denied" in posted));
      assert.equal(posted.message.body, "still here");
      assert.equal(posted.message.bot, registered.bot.id);

      const restarted = openAt(file);
      const again = restarted.registerBot({
        owner: ALICE,
        label: "ledger",
        nowSeconds: NOW + 5,
      });
      assert.ok(!("denied" in again));
      assert.equal(again.bot.id, registered.bot.id);
      assert.equal(again.bot.status, "active");
      const read = restarted.read({ owner: ALICE });
      assert.ok(!("denied" in read));
      assert.deepEqual(
        read.messages.map((row) => row.body),
        ["still here"],
      );
      assert.equal(read.messages[0]?.bot, registered.bot.id);
      assert.equal(read.channel?.owner, ALICE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("archiving the bot leaves the forum history", () => {
    const { dir, file } = tempFile();
    try {
      const chat = openAt(file);
      const registered = chat.registerBot({
        owner: ALICE,
        label: "ledger",
        kind: "cloud-agent",
        nowSeconds: NOW,
        entropy: "cc33",
      });
      assert.ok(!("denied" in registered));
      const posted = chat.post({
        owner: ALICE,
        botId: registered.bot.id,
        body: "keep this",
        nowSeconds: NOW + 2,
        entropy: "dd44",
      });
      assert.ok(!("denied" in posted));

      const archived = chat.archiveBot({
        owner: ALICE,
        botId: registered.bot.id,
        nowSeconds: NOW + 3,
      });
      assert.ok(!("denied" in archived));
      assert.equal(archived.bot.status, "archived");
      assert.equal(archived.bot.id, registered.bot.id);
      assert.equal(archived.bot.member, true);

      const after = chat.post({
        owner: ALICE,
        botId: registered.bot.id,
        body: "should not land",
        nowSeconds: NOW + 4,
        entropy: "ee55",
      });
      assert.deepEqual(after, { denied: true, reason: "archived" });

      const reopened = openAt(file);
      const read = reopened.read({ owner: ALICE });
      assert.ok(!("denied" in read));
      assert.deepEqual(
        read.messages.map((row) => row.body),
        ["keep this"],
      );
      assert.equal(read.bots.find((row) => row.id === registered.bot.id)?.status, "archived");
      const again = reopened.registerBot({
        owner: ALICE,
        label: "ledger",
        nowSeconds: NOW + 9,
      });
      assert.ok(!("denied" in again));
      assert.equal(again.bot.id, registered.bot.id);
      assert.equal(again.bot.kind, "cloud-agent");
      assert.equal(again.bot.status, "archived");
      const raw = JSON.parse(readFileSync(file, "utf8")) as {
        messages: { body: string }[];
        bots: { status: string }[];
      };
      assert.deepEqual(
        raw.messages.map((row) => row.body),
        ["keep this"],
      );
      assert.equal(raw.bots[0]?.status, "archived");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a different owner cannot read the channel", () => {
    const { dir, file } = tempFile();
    try {
      const chat = openAt(file);
      const registered = chat.registerBot({
        owner: ALICE,
        label: "ledger",
        nowSeconds: NOW,
        entropy: "ff66",
      });
      assert.ok(!("denied" in registered));
      assert.ok(
        !("denied" in
          chat.post({
            owner: ALICE,
            botId: registered.bot.id,
            body: "alice only",
            nowSeconds: NOW + 1,
            entropy: "a1b2",
          })),
      );

      const bob = openAt(file);
      const asBob = bob.read({ owner: BOB });
      assert.ok(!("denied" in asBob));
      assert.equal(asBob.channel, null);
      assert.deepEqual(asBob.messages, []);
      assert.deepEqual(asBob.bots, []);

      const asBobsBot = bob.read({ owner: BOB, botId: registered.bot.id });
      assert.deepEqual(asBobsBot, { denied: true, reason: "unknown-bot" });

      const posted = bob.post({
        owner: BOB,
        botId: registered.bot.id,
        body: "nope",
        entropy: "c3d4",
      });
      assert.deepEqual(posted, { denied: true, reason: "unknown-bot" });

      const alice = openAt(file).read({ owner: ALICE });
      assert.ok(!("denied" in alice));
      assert.deepEqual(
        alice.messages.map((row) => row.body),
        ["alice only"],
      );

      const http = handleForumGet(openAt(file), BOB);
      assert.equal(http.status, 200);
      assert.deepEqual(http.body.messages, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("copy gets a new id and does not take the original membership", () => {
    const { dir, file } = tempFile();
    try {
      const chat = openAt(file);
      const original = chat.registerBot({
        owner: ALICE,
        label: "ledger",
        nowSeconds: NOW,
        entropy: "orig01",
      });
      assert.ok(!("denied" in original));
      assert.ok(
        !("denied" in
          chat.post({
            owner: ALICE,
            botId: original.bot.id,
            body: "from the original",
            nowSeconds: NOW + 1,
            entropy: "msg01",
          })),
      );

      const copied = chat.copyBot({
        owner: ALICE,
        botId: original.bot.id,
        label: "ledger copy",
        nowSeconds: NOW + 2,
        entropy: "copy01",
      });
      assert.ok(!("denied" in copied));
      assert.notEqual(copied.bot.id, original.bot.id);
      assert.equal(copied.bot.member, false);
      assert.equal(copied.bot.owner, ALICE);

      const takeover = chat.post({
        owner: ALICE,
        botId: copied.bot.id,
        body: "should not land",
        nowSeconds: NOW + 3,
        entropy: "msg02",
      });
      assert.deepEqual(takeover, { denied: true, reason: "not-member" });

      const stillOriginal = chat.read({ owner: ALICE, botId: original.bot.id });
      assert.ok(!("denied" in stillOriginal));
      assert.equal(stillOriginal.messages[0]?.bot, original.bot.id);
      assert.equal(stillOriginal.messages[0]?.body, "from the original");

      const copyRead = chat.read({ owner: ALICE, botId: copied.bot.id });
      assert.deepEqual(copyRead, { denied: true, reason: "not-member" });

      const joined = chat.joinBot({
        owner: ALICE,
        botId: copied.bot.id,
        nowSeconds: NOW + 4,
      });
      assert.ok(!("denied" in joined));
      assert.equal(joined.bot.member, true);
      const fromCopy = chat.post({
        owner: ALICE,
        botId: copied.bot.id,
        body: "from the copy",
        nowSeconds: NOW + 5,
        entropy: "msg03",
      });
      assert.ok(!("denied" in fromCopy));
      assert.equal(fromCopy.message.bot, copied.bot.id);

      const ownerView = openAt(file).read({ owner: ALICE });
      assert.ok(!("denied" in ownerView));
      assert.deepEqual(
        ownerView.messages.map((row) => [row.bot, row.body]),
        [
          [original.bot.id, "from the original"],
          [copied.bot.id, "from the copy"],
        ],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an unknown file version without rewriting it", () => {
    const { dir, file } = tempFile();
    try {
      writeFileSync(file, JSON.stringify({ v: 2, messages: [{ body: "keep" }] }), "utf8");
      const chat = openAt(file);
      const read = chat.read({ owner: ALICE });
      assert.deepEqual(read, { denied: true, reason: "unknown-version" });
      const raw = readFileSync(file, "utf8");
      assert.match(raw, /"v":2/);
      assert.match(raw, /keep/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("session owner is the scope; the JSON body cannot name another owner", () => {
    const { dir, file } = tempFile();
    try {
      const chat = openAt(file);
      const registered = handleForumPost(chat, ALICE, {
        action: "register",
        label: "ledger",
        entropy: "http01",
        nowSeconds: NOW,
        owner: BOB,
      });
      assert.equal(registered.status, 200);
      const botId = (registered.body.bot as { id: string }).id;
      assert.match(botId, new RegExp(`^s3rch:bot:${ALICE}:`));

      const posted = handleForumPost(chat, ALICE, {
        action: "post",
        botId,
        body: "scoped",
        entropy: "http02",
        nowSeconds: NOW + 1,
        owner: BOB,
      });
      assert.equal(posted.status, 200);

      const bobRead = handleForumPost(openAt(file), BOB, {
        action: "read",
        owner: ALICE,
      });
      assert.equal(bobRead.status, 200);
      assert.deepEqual(bobRead.body.messages, []);

      const aliceRead = handleForumGet(openAt(file), ALICE);
      assert.equal(aliceRead.status, 200);
      const messages = aliceRead.body.messages as { body: string }[];
      assert.deepEqual(
        messages.map((row) => row.body),
        ["scoped"],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("forum invites and groups", () => {
  const CAROL = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

  function register(chat: Forum, owner: string, entropy: string) {
    const registered = chat.registerBot({
      owner,
      label: "ledger",
      nowSeconds: NOW,
      entropy,
    });
    assert.ok(!("denied" in registered));
    return registered.bot.id;
  }

  it("stays owner-private until a direct invite, and a guest bot posts on that channel", () => {
    const { dir, file } = tempFile();
    try {
      const chat = openAt(file);
      const aliceBot = register(chat, ALICE, "inv01");
      assert.ok(
        !("denied" in
          chat.post({
            owner: ALICE,
            botId: aliceBot,
            body: "alice only",
            nowSeconds: NOW + 1,
            entropy: "inv02",
          })),
      );
      const bobBot = register(chat, BOB, "inv03");
      const channel = `s3rch:forum:${ALICE}`;

      const blocked = chat.post({
        owner: BOB,
        botId: bobBot,
        body: "nope",
        channel,
        nowSeconds: NOW + 2,
        entropy: "inv04",
      });
      assert.deepEqual(blocked, { denied: true, reason: "not-invited" });
      const hidden = chat.read({ owner: BOB });
      assert.ok(!("denied" in hidden));
      assert.deepEqual(hidden.messages, []);
      assert.deepEqual(hidden.shared, []);

      const invited = handleForumPost(chat, ALICE, {
        action: "invite",
        guest: BOB.toLowerCase(),
        owner: BOB,
        nowSeconds: NOW + 3,
      });
      assert.equal(invited.status, 200);

      const self = handleForumPost(chat, ALICE, { action: "invite", guest: ALICE });
      assert.equal(self.status, 400);
      assert.deepEqual(self.body, { denied: true, reason: "bad-guest" });

      const posted = handleForumPost(chat, BOB, {
        action: "post",
        botId: bobBot,
        body: "from bob",
        channel,
        owner: ALICE,
        nowSeconds: NOW + 4,
        entropy: "inv05",
      });
      assert.equal(posted.status, 200);
      const message = posted.body.message as { owner: string; channel: string; bot: string };
      assert.equal(message.owner, BOB);
      assert.equal(message.channel, channel);
      assert.equal(message.bot, bobBot);

      const alice = chat.read({ owner: ALICE });
      assert.ok(!("denied" in alice));
      assert.deepEqual(
        alice.messages.map((row) => row.body),
        ["alice only", "from bob"],
      );
      const bob = chat.read({ owner: BOB });
      assert.ok(!("denied" in bob));
      assert.deepEqual(bob.messages, []);
      assert.deepEqual(
        bob.shared.map((row) => row.messages.map((item) => item.body)),
        [["alice only", "from bob"]],
      );

      const carolInvite = handleForumPost(chat, BOB, {
        action: "invite",
        guest: CAROL,
        channel,
        owner: ALICE,
      });
      assert.equal(carolInvite.status, 200);
      const carol = chat.read({ owner: CAROL });
      assert.ok(!("denied" in carol));
      assert.equal(
        carol.shared.some((row) => row.channel.owner === ALICE),
        false,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps group membership after uninvite, and a direct invite after group removal", () => {
    const { dir, file } = tempFile();
    try {
      const chat = openAt(file);
      register(chat, ALICE, "grp01");
      const bobBot = register(chat, BOB, "grp02");
      const channel = `s3rch:forum:${ALICE}`;
      assert.ok(!("denied" in chat.invite({ owner: ALICE, guest: BOB, nowSeconds: NOW })));
      const grouped = handleForumPost(chat, ALICE, {
        action: "group",
        label: "crew",
        entropy: "grp03",
        nowSeconds: NOW + 1,
      });
      assert.equal(grouped.status, 200);
      const groupId = (grouped.body.group as { id: string }).id;
      assert.match(groupId, new RegExp(`^s3rch:forum-group:${ALICE}:`));
      assert.equal(
        handleForumPost(chat, ALICE, {
          action: "group-add",
          groupId,
          member: BOB,
          nowSeconds: NOW + 2,
        }).status,
        200,
      );
      assert.equal(handleForumPost(chat, BOB, { action: "group-add", groupId, member: CAROL }).status, 403);

      assert.ok(!("denied" in chat.uninvite({ owner: ALICE, guest: BOB })));
      const viaGroup = chat.read({ owner: BOB });
      assert.ok(!("denied" in viaGroup));
      assert.equal(viaGroup.shared.length, 1);
      assert.ok(
        !("denied" in
          chat.post({
            owner: BOB,
            botId: bobBot,
            body: "still in",
            channel,
            nowSeconds: NOW + 3,
            entropy: "grp04",
          })),
      );

      assert.ok(!("denied" in chat.removeGroupMember({ owner: ALICE, groupId, member: BOB })));
      const dropped = chat.read({ owner: BOB });
      assert.ok(!("denied" in dropped));
      assert.deepEqual(dropped.shared, []);

      assert.ok(!("denied" in chat.invite({ owner: ALICE, guest: BOB, nowSeconds: NOW + 4 })));
      assert.ok(!("denied" in chat.removeGroupMember({ owner: ALICE, groupId, member: BOB })));
      const viaInvite = chat.read({ owner: BOB });
      assert.ok(!("denied" in viaInvite));
      assert.equal(viaInvite.shared.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads a v1 file that has no invite rows and does not rewrite it", () => {
    const { dir, file } = tempFile();
    try {
      const bot = `s3rch:bot:${ALICE}:old1`;
      const channel = `s3rch:forum:${ALICE}`;
      const raw = JSON.stringify({
        v: 1,
        channels: [{ id: channel, owner: ALICE, created: NOW, v: 1 }],
        bots: [
          {
            id: bot,
            owner: ALICE,
            label: "ledger",
            kind: "bot",
            status: "active",
            created: NOW,
            archivedAt: null,
            v: 1,
          },
        ],
        memberships: [{ channel, bot, owner: ALICE, joined: NOW }],
        messages: [
          {
            id: "m1",
            channel,
            owner: ALICE,
            bot,
            body: "kept",
            ts: NOW,
            v: 1,
          },
        ],
      });
      writeFileSync(file, raw, "utf8");
      const read = openAt(file).read({ owner: ALICE });
      assert.ok(!("denied" in read));
      assert.deepEqual(
        read.messages.map((row) => row.body),
        ["kept"],
      );
      assert.deepEqual(read.shared, []);
      assert.equal(readFileSync(file, "utf8"), raw);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("forum desktop feed", () => {
  const CAROL = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
  const SESSION = "11111111-1111-4111-8111-111111111111";
  const HANDLE = "abc123def0";
  const MARKER = "VISORPNGMARKER";

  function desktopPost(extra: Record<string, unknown> = {}) {
    return {
      action: "desktop",
      session: SESSION,
      snapshot: { handle: HANDLE, mime: "image/png", seq: 1 },
      png_base64: Buffer.from(MARKER, "utf8").toString("base64"),
      thinking: [
        { kind: "prompt", text: "count the sheep" },
        { kind: "type", text: "cargo test --locked hunter2" },
        { kind: "focus", text: "gnome-terminal" },
      ],
      files: [{ handle: "notes.txt", value: "SECRETFILEBYTES" }],
      secrets: [{ handle: "password", value: "hunter2" }],
      nowSeconds: NOW,
      ...extra,
    };
  }

  it("shows the snapshot and thinking to the owner, an invite, and a group, and to nobody else", () => {
    const { dir, file } = tempFile();
    try {
      const chat = openAt(file);
      const posted = handleForumPost(chat, ALICE, desktopPost());
      assert.equal(posted.status, 200);
      const saved = readFileSync(file, "utf8");
      assert.equal(saved.includes(MARKER), false);
      assert.equal(saved.includes(Buffer.from(MARKER, "utf8").toString("base64")), false);
      assert.equal(saved.includes("hunter2"), false);
      assert.equal(saved.includes("SECRETFILEBYTES"), false);
      assert.equal(saved.includes(HANDLE), true);

      const alice = chat.read({ owner: ALICE });
      assert.ok(!("denied" in alice));
      assert.equal(alice.desktop?.snapshot?.handle, HANDLE);
      assert.deepEqual(
        alice.desktop?.thinking.map((row) => row.text),
        ["count the sheep", "cargo test --locked ***", "gnome-terminal"],
      );
      assert.deepEqual(alice.desktop?.files, [{ handle: "notes.txt" }]);
      assert.deepEqual(alice.desktop?.secrets, [{ handle: "password" }]);
      assert.equal(JSON.stringify(alice).includes("hunter2"), false);
      const png = chat.readSnapshot({ owner: ALICE, handle: HANDLE });
      assert.equal(png?.bytes.toString("utf8"), MARKER);

      const hidden = chat.read({ owner: BOB });
      assert.ok(!("denied" in hidden));
      assert.equal(hidden.desktop, null);
      assert.deepEqual(hidden.shared, []);
      assert.equal(chat.readSnapshot({ owner: BOB, handle: HANDLE }), null);

      assert.ok(!("denied" in chat.invite({ owner: ALICE, guest: BOB, nowSeconds: NOW + 1 })));
      const invited = chat.read({ owner: BOB });
      assert.ok(!("denied" in invited));
      assert.equal(invited.shared[0]?.desktop?.snapshot?.handle, HANDLE);
      assert.equal(chat.readSnapshot({ owner: BOB, handle: HANDLE })?.bytes.toString("utf8"), MARKER);

      assert.ok(!("denied" in chat.uninvite({ owner: ALICE, guest: BOB })));
      assert.equal(chat.read({ owner: BOB }).shared.length, 0);
      assert.equal(chat.readSnapshot({ owner: BOB, handle: HANDLE }), null);

      const grouped = chat.createGroup({
        owner: ALICE,
        label: "crew",
        entropy: "desk1",
        nowSeconds: NOW + 2,
      });
      assert.ok(!("denied" in grouped));
      assert.ok(
        !("denied" in
          chat.addGroupMember({
            owner: ALICE,
            groupId: grouped.group.id,
            member: CAROL,
            nowSeconds: NOW + 3,
          })),
      );
      const member = chat.read({ owner: CAROL });
      assert.ok(!("denied" in member));
      assert.equal(member.shared[0]?.desktop?.thinking.some((row) => row.kind === "type"), true);
      assert.equal(chat.readSnapshot({ owner: CAROL, handle: HANDLE })?.mime, "image/png");
      assert.equal(chat.read({ owner: BOB }).shared.length, 0);

      const restarted = openAt(file);
      const again = restarted.read({ owner: ALICE });
      assert.ok(!("denied" in again));
      assert.equal(again.desktop?.snapshot?.handle, HANDLE);
      assert.equal(restarted.readSnapshot({ owner: ALICE, handle: HANDLE }), null);
      assert.equal(readFileSync(file, "utf8").includes(MARKER), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("forum route", () => {
  it("uses the SIWE session and does not invent an API key", () => {
    const route = readFileSync(
      fileURLToPath(new URL("../app/api/forum/route.ts", import.meta.url)),
      "utf8",
    );
    assert.equal(route.includes("readSessionToken"), true);
    assert.equal(route.includes("session.address"), true);
    assert.equal(route.includes("ownerForWallet"), true);
    assert.equal(route.includes("ownerForOAuth"), true);
    assert.equal(route.includes("readForumBotToken"), true);
    assert.equal(route.includes("x-s3rch-forum-token"), true);
    assert.equal(route.includes("X-Api-Key"), false);
    assert.equal(route.includes("authorization"), false);
    assert.equal(route.includes("SEED_SECRET"), false);
  });
});
