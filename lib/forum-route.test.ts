import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { GET, POST } from "../app/api/forum/route";
import { GET as sessionGET } from "../app/api/identity/session/route";
import { oauthSessionCookieName, sessionCookieName } from "./identity/cookies";
import { linkLoginPaths } from "./identity/link";
import { signBackupSession } from "./identity/oauth";
import { getIdentitySecret } from "./identity/secret";
import { signSessionToken } from "./identity/session";

const ALICE = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const BOB = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const CAROL = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const DAVE = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
const EVE = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";
const CHANNEL = `s3rch:forum:${ALICE}`;

describe("forum route resolves a login, then honors invites", { concurrency: 1 }, () => {
  it("uses the sociacl owner for invite and group checks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "s3rch-forum-route-"));
    const previousForum = process.env.S3RCH_FORUM;
    const previousLinks = process.env.S3RCH_IDENTITY_LINKS;
    process.env.S3RCH_FORUM = join(dir, "forum.json");
    process.env.S3RCH_IDENTITY_LINKS = join(dir, "identity-links.json");
    try {
      const secret = getIdentitySecret();
      linkLoginPaths({ wallet: ALICE, sub: "kc-alice", idp: "github" });
      linkLoginPaths({ wallet: BOB, sub: "kc-alice", idp: "github" });
      linkLoginPaths({ wallet: CAROL, sub: "kc-carol", idp: "google" });
      linkLoginPaths({ wallet: EVE, sub: "kc-carol", idp: "google" });

      const alice = await siweCookie(ALICE, secret);
      const bob = await siweCookie(BOB, secret);
      const dave = await siweCookie(DAVE, secret);
      const eve = await siweCookie(EVE, secret);
      const carol = await oauthCookie("kc-carol", secret);
      const stranger = await oauthCookie("kc-stranger", secret);

      assert.equal((await GET(req(stranger))).status, 401);
      assert.equal((await GET(req())).status, 401);

      const registered = await post(alice, {
        action: "register",
        label: "ledger",
        entropy: "rt01",
      });
      assert.equal(registered.status, 200);
      const aliceBot = (registered.body.bot as { id: string }).id;
      assert.match(aliceBot, new RegExp(`^s3rch:bot:${ALICE}:`));
      assert.equal(
        (
          await post(alice, {
            action: "post",
            botId: aliceBot,
            body: "alice only",
            entropy: "rt02",
            nowSeconds: 1_700_000_001,
          })
        ).status,
        200,
      );

      const asBob = await read(bob);
      assert.equal(asBob.status, 200);
      assert.equal((asBob.body.channel as { owner: string }).owner, ALICE);
      assert.deepEqual(
        (asBob.body.messages as { body: string }[]).map((row) => row.body),
        ["alice only"],
      );
      assert.deepEqual(asBob.body.shared, []);

      const asCarol = await read(carol);
      assert.equal(asCarol.status, 200);
      assert.deepEqual(asCarol.body.messages, []);
      assert.deepEqual(asCarol.body.shared, []);
      const asDave = await read(dave);
      assert.deepEqual(asDave.body.messages, []);
      assert.deepEqual(asDave.body.shared, []);

      assert.equal((await post(bob, { action: "invite", guest: CAROL, owner: DAVE })).status, 200);
      const invited = await read(carol);
      assert.equal((invited.body.shared as { channel: { owner: string } }[])[0]?.channel.owner, ALICE);

      const carolBot = await post(carol, { action: "register", label: "ledger", entropy: "rt03" });
      assert.equal(carolBot.status, 200);
      const botId = (carolBot.body.bot as { id: string }).id;
      assert.match(botId, new RegExp(`^s3rch:bot:${CAROL}:`));
      const guestPost = await post(carol, {
        action: "post",
        botId,
        body: "from carol",
        channel: CHANNEL,
        owner: ALICE,
        entropy: "rt04",
        nowSeconds: 1_700_000_002,
      });
      assert.equal(guestPost.status, 200);
      const message = guestPost.body.message as { owner: string; channel: string };
      assert.equal(message.owner, CAROL);
      assert.equal(message.channel, CHANNEL);

      const aliceView = await read(alice);
      assert.deepEqual(
        (aliceView.body.messages as { body: string }[]).map((row) => row.body),
        ["alice only", "from carol"],
      );

      assert.equal((await post(alice, { action: "uninvite", guest: CAROL })).status, 200);
      const afterUninvite = await read(carol);
      assert.deepEqual(afterUninvite.body.shared, []);
      assert.deepEqual((await read(eve)).body.shared, []);

      const grouped = await post(alice, { action: "group", label: "crew", entropy: "rt05" });
      assert.equal(grouped.status, 200);
      const groupId = (grouped.body.group as { id: string }).id;
      assert.equal((await post(alice, { action: "group-add", groupId, member: CAROL })).status, 200);
      const viaGroup = await read(eve);
      assert.equal((viaGroup.body.shared as unknown[]).length, 1);
      assert.deepEqual((await read(dave)).body.shared, []);

      const both = new Request("http://localhost/api/forum", {
        headers: { cookie: `${bob}; ${stranger}` },
      });
      assert.equal((await GET(both)).status, 200);
      assert.equal((await GET(req(stranger))).status, 401);

      const bobSession = await sessionGET(sessionReq(bob));
      assert.equal(bobSession.status, 200);
      const bobBody = (await bobSession.json()) as { address: string; owner: string };
      assert.equal(bobBody.address, BOB);
      assert.equal(bobBody.owner, ALICE);
      const daveSession = await sessionGET(sessionReq(dave));
      const daveBody = (await daveSession.json()) as { address: string; owner: string };
      assert.equal(daveBody.address, DAVE);
      assert.equal(daveBody.owner, DAVE);
      assert.equal((await sessionGET(sessionReq(carol))).status, 401);

      const minted = await post(bob, { action: "token" });
      assert.equal(minted.status, 200);
      assert.equal(minted.body.owner, ALICE);
      const forumToken = minted.body.token as string;
      assert.equal(forumToken.includes("hm_"), false);
      const asToken = await GET(
        new Request("http://localhost/api/forum", {
          headers: { "x-s3rch-forum-token": forumToken },
        }),
      );
      assert.equal(asToken.status, 200);
      const tokenView = (await asToken.json()) as {
        channel: { owner: string };
        messages: { body: string }[];
      };
      assert.equal(tokenView.channel.owner, ALICE);
      assert.deepEqual(
        tokenView.messages.map((row) => row.body),
        ["alice only", "from carol"],
      );
      const remint = await POST(
        new Request("http://localhost/api/forum", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-s3rch-forum-token": forumToken,
          },
          body: JSON.stringify({ action: "token" }),
        }),
      );
      assert.equal(remint.status, 403);
      assert.equal((await remint.json()).reason, "forum-token");
      assert.equal(
        (
          await GET(
            new Request("http://localhost/api/forum", {
              headers: { "x-s3rch-forum-token": "not-a-token" },
            }),
          )
        ).status,
        401,
      );

      const sessionRoute = readFileSync(
        fileURLToPath(new URL("../app/api/identity/session/route.ts", import.meta.url)),
        "utf8",
      );
      assert.equal(sessionRoute.includes("ownerForWallet"), true);
      assert.equal(sessionRoute.includes("address: session.address"), true);
      assert.equal(sessionRoute.includes("ownerForOAuth"), false);
    } finally {
      if (previousForum === undefined) delete process.env.S3RCH_FORUM;
      else process.env.S3RCH_FORUM = previousForum;
      if (previousLinks === undefined) delete process.env.S3RCH_IDENTITY_LINKS;
      else process.env.S3RCH_IDENTITY_LINKS = previousLinks;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function req(cookie?: string): Request {
  return new Request("http://localhost/api/forum", {
    headers: cookie ? { cookie } : {},
  });
}

function sessionReq(cookie: string): Request {
  return new Request("http://localhost/api/identity/session", {
    headers: { cookie },
  });
}

async function post(cookie: string, body: Record<string, unknown>) {
  const response = await POST(
    new Request("http://localhost/api/forum", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function read(cookie: string) {
  const response = await GET(req(cookie));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function siweCookie(address: string, secret: string): Promise<string> {
  const token = await signSessionToken({ address, chainId: 1 }, secret);
  return `${sessionCookieName(false)}=${token}`;
}

async function oauthCookie(sub: string, secret: string): Promise<string> {
  const token = await signBackupSession({ sub, idp: "github" }, secret);
  return `${oauthSessionCookieName(false)}=${token}`;
}
