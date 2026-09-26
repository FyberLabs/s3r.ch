import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  FileRenterChatStore,
  handleRenterChatGet,
  handleRenterChatPost,
  openRenterChat,
  type RenterChat,
} from "./renter-chat";

const ALICE = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const BOB = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const NOW = 1_700_000_000;

function tempFile(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "s3rch-renter-chat-"));
  return { dir, file: join(dir, "renter-chat.json") };
}

function openAt(file: string): RenterChat {
  return openRenterChat(new FileRenterChatStore(file));
}

describe("renter chat ledger", () => {
  it("a message posted by a bot is still there after a simulated restart", () => {
    const { dir, file } = tempFile();
    try {
      const first = openAt(file);
      const registered = first.registerBot({
        renter: ALICE.toLowerCase(),
        label: "ledger",
        nowSeconds: NOW,
        entropy: "aa11",
      });
      assert.ok(!("denied" in registered));
      assert.equal(registered.bot.member, true);
      assert.equal(registered.bot.renter, ALICE);
      const posted = first.post({
        renter: ALICE,
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
        renter: ALICE,
        label: "ledger",
        nowSeconds: NOW + 5,
      });
      assert.ok(!("denied" in again));
      assert.equal(again.bot.id, registered.bot.id);
      assert.equal(again.bot.status, "active");
      const read = restarted.read({ renter: ALICE });
      assert.ok(!("denied" in read));
      assert.deepEqual(
        read.messages.map((row) => row.body),
        ["still here"],
      );
      assert.equal(read.messages[0]?.bot, registered.bot.id);
      assert.equal(read.channel?.renter, ALICE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("archiving the bot leaves the renter history", () => {
    const { dir, file } = tempFile();
    try {
      const chat = openAt(file);
      const registered = chat.registerBot({
        renter: ALICE,
        label: "ledger",
        kind: "cloud-agent",
        nowSeconds: NOW,
        entropy: "cc33",
      });
      assert.ok(!("denied" in registered));
      const posted = chat.post({
        renter: ALICE,
        botId: registered.bot.id,
        body: "keep this",
        nowSeconds: NOW + 2,
        entropy: "dd44",
      });
      assert.ok(!("denied" in posted));

      const archived = chat.archiveBot({
        renter: ALICE,
        botId: registered.bot.id,
        nowSeconds: NOW + 3,
      });
      assert.ok(!("denied" in archived));
      assert.equal(archived.bot.status, "archived");
      assert.equal(archived.bot.id, registered.bot.id);
      assert.equal(archived.bot.member, true);

      const after = chat.post({
        renter: ALICE,
        botId: registered.bot.id,
        body: "should not land",
        nowSeconds: NOW + 4,
        entropy: "ee55",
      });
      assert.deepEqual(after, { denied: true, reason: "archived" });

      const reopened = openAt(file);
      const read = reopened.read({ renter: ALICE });
      assert.ok(!("denied" in read));
      assert.deepEqual(
        read.messages.map((row) => row.body),
        ["keep this"],
      );
      assert.equal(read.bots.find((row) => row.id === registered.bot.id)?.status, "archived");
      const again = reopened.registerBot({
        renter: ALICE,
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

  it("a different renter cannot read the channel", () => {
    const { dir, file } = tempFile();
    try {
      const chat = openAt(file);
      const registered = chat.registerBot({
        renter: ALICE,
        label: "ledger",
        nowSeconds: NOW,
        entropy: "ff66",
      });
      assert.ok(!("denied" in registered));
      assert.ok(
        !("denied" in
          chat.post({
            renter: ALICE,
            botId: registered.bot.id,
            body: "alice only",
            nowSeconds: NOW + 1,
            entropy: "a1b2",
          })),
      );

      const bob = openAt(file);
      const asBob = bob.read({ renter: BOB });
      assert.ok(!("denied" in asBob));
      assert.equal(asBob.channel, null);
      assert.deepEqual(asBob.messages, []);
      assert.deepEqual(asBob.bots, []);

      const asBobsBot = bob.read({ renter: BOB, botId: registered.bot.id });
      assert.deepEqual(asBobsBot, { denied: true, reason: "unknown-bot" });

      const posted = bob.post({
        renter: BOB,
        botId: registered.bot.id,
        body: "nope",
        entropy: "c3d4",
      });
      assert.deepEqual(posted, { denied: true, reason: "unknown-bot" });

      const alice = openAt(file).read({ renter: ALICE });
      assert.ok(!("denied" in alice));
      assert.deepEqual(
        alice.messages.map((row) => row.body),
        ["alice only"],
      );

      const http = handleRenterChatGet(openAt(file), BOB);
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
        renter: ALICE,
        label: "ledger",
        nowSeconds: NOW,
        entropy: "orig01",
      });
      assert.ok(!("denied" in original));
      assert.ok(
        !("denied" in
          chat.post({
            renter: ALICE,
            botId: original.bot.id,
            body: "from the original",
            nowSeconds: NOW + 1,
            entropy: "msg01",
          })),
      );

      const copied = chat.copyBot({
        renter: ALICE,
        botId: original.bot.id,
        label: "ledger copy",
        nowSeconds: NOW + 2,
        entropy: "copy01",
      });
      assert.ok(!("denied" in copied));
      assert.notEqual(copied.bot.id, original.bot.id);
      assert.equal(copied.bot.member, false);
      assert.equal(copied.bot.renter, ALICE);

      const takeover = chat.post({
        renter: ALICE,
        botId: copied.bot.id,
        body: "should not land",
        nowSeconds: NOW + 3,
        entropy: "msg02",
      });
      assert.deepEqual(takeover, { denied: true, reason: "not-member" });

      const stillOriginal = chat.read({ renter: ALICE, botId: original.bot.id });
      assert.ok(!("denied" in stillOriginal));
      assert.equal(stillOriginal.messages[0]?.bot, original.bot.id);
      assert.equal(stillOriginal.messages[0]?.body, "from the original");

      const copyRead = chat.read({ renter: ALICE, botId: copied.bot.id });
      assert.deepEqual(copyRead, { denied: true, reason: "not-member" });

      const joined = chat.joinBot({
        renter: ALICE,
        botId: copied.bot.id,
        nowSeconds: NOW + 4,
      });
      assert.ok(!("denied" in joined));
      assert.equal(joined.bot.member, true);
      const fromCopy = chat.post({
        renter: ALICE,
        botId: copied.bot.id,
        body: "from the copy",
        nowSeconds: NOW + 5,
        entropy: "msg03",
      });
      assert.ok(!("denied" in fromCopy));
      assert.equal(fromCopy.message.bot, copied.bot.id);

      const renterView = openAt(file).read({ renter: ALICE });
      assert.ok(!("denied" in renterView));
      assert.deepEqual(
        renterView.messages.map((row) => [row.bot, row.body]),
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
      const read = chat.read({ renter: ALICE });
      assert.deepEqual(read, { denied: true, reason: "unknown-version" });
      const raw = readFileSync(file, "utf8");
      assert.match(raw, /"v":2/);
      assert.match(raw, /keep/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("session renter is the scope; the JSON body cannot name another renter", () => {
    const { dir, file } = tempFile();
    try {
      const chat = openAt(file);
      const registered = handleRenterChatPost(chat, ALICE, {
        action: "register",
        label: "ledger",
        entropy: "http01",
        nowSeconds: NOW,
        renter: BOB,
      });
      assert.equal(registered.status, 200);
      const botId = (registered.body.bot as { id: string }).id;
      assert.match(botId, new RegExp(`^s3rch:bot:${ALICE}:`));

      const posted = handleRenterChatPost(chat, ALICE, {
        action: "post",
        botId,
        body: "scoped",
        entropy: "http02",
        nowSeconds: NOW + 1,
        renter: BOB,
      });
      assert.equal(posted.status, 200);

      const bobRead = handleRenterChatPost(openAt(file), BOB, {
        action: "read",
        renter: ALICE,
      });
      assert.equal(bobRead.status, 200);
      assert.deepEqual(bobRead.body.messages, []);

      const aliceRead = handleRenterChatGet(openAt(file), ALICE);
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

describe("renter chat route", () => {
  it("uses the SIWE session and does not invent an API key", () => {
    const route = readFileSync(
      fileURLToPath(new URL("../app/api/renter-chat/route.ts", import.meta.url)),
      "utf8",
    );
    assert.equal(route.includes("readSessionToken"), true);
    assert.equal(route.includes("session.address"), true);
    assert.equal(route.includes("X-Api-Key"), false);
    assert.equal(route.includes("authorization"), false);
    assert.equal(route.includes("SEED_SECRET"), false);
  });
});
