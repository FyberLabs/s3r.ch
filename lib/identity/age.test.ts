import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { generateKeyPair, SignJWT } from "jose";
import { privateKeyToAccount } from "viem/accounts";
import { AgeConfirmation, AGE_CONFIRMATION_LABEL } from "../../components/AgeConfirmation";
import { SignInOptions } from "../../components/SignInOptions";
import { POST as verifySignIn } from "../../app/api/identity/verify/route";
import { completeWalletSignIn, AGE_CONFIRMATION_REQUIRED } from "./age";
import { LOCAL_SESSION_SECRET, OAUTH_CLIENT_ID } from "./config";
import { nonceCookieName, oauthAgeCookieName, oauthPkceCookieName, oauthSessionCookieName } from "./cookies";
import { FileLinkStore, openLinks, parseLinkFile } from "./link";
import { issueNonce } from "./nonce";
import { acceptOAuthAge, beginOAuth, finishOAuth, readBackupSession } from "./oauth";
import { buildSiweMessage } from "./siwe";
import { readSessionToken } from "./session";

const ALICE = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const SECRET = LOCAL_SESSION_SECRET;
const STAMP = "2026-10-09T12:00:00.000Z";
const ISSUER = "https://auth.test.hyperme.sh/realms/controlplane";

function useFile(): { dir: string; file: string; restore: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "s3rch-age-"));
  const file = join(dir, "identity-links.json");
  const previous = process.env.S3RCH_IDENTITY_LINKS;
  process.env.S3RCH_IDENTITY_LINKS = file;
  return {
    dir,
    file,
    restore() {
      if (previous === undefined) delete process.env.S3RCH_IDENTITY_LINKS;
      else process.env.S3RCH_IDENTITY_LINKS = previous;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function sessionCookie(response: Response): string | undefined {
  const name = oauthSessionCookieName(false);
  return response.headers.getSetCookie().find((row) => row.startsWith(`${name}=`));
}

describe("age confirmation on wallet sign-in", () => {
  it("issues no session without a confirmation, then stores it and skips the ask", async () => {
    const store = useFile();
    try {
      const first = await completeWalletSignIn({
        address: ALICE,
        chainId: 1,
        ageConfirmed: false,
        secret: SECRET,
      });
      assert.deepEqual(first, { ok: false, status: 403, error: AGE_CONFIRMATION_REQUIRED });
      assert.equal("token" in first, false);
      let raw = "";
      try {
        raw = readFileSync(store.file, "utf8");
      } catch {
        raw = "";
      }
      assert.equal(raw.includes("ageConfirmedAt"), false);

      const now = new Date("2026-10-09T15:04:05.000Z");
      const issued = await completeWalletSignIn({
        address: ALICE.toLowerCase(),
        chainId: 1,
        ageConfirmed: true,
        secret: SECRET,
        now,
      });
      assert.equal(issued.ok, true);
      if (!issued.ok) return;
      const claims = await readSessionToken(issued.token, SECRET);
      assert.equal(claims.address, ALICE);
      assert.equal(issued.confirmedAt, now.toISOString());
      const saved = JSON.parse(readFileSync(store.file, "utf8")) as {
        people: { owner: string; ageConfirmedAt?: string }[];
      };
      assert.equal(saved.people[0]?.owner, ALICE);
      assert.equal(saved.people[0]?.ageConfirmedAt, now.toISOString());

      const reopened = openLinks(new FileLinkStore(store.file));
      assert.deepEqual(reopened.ageStatusForWallet(ALICE), { confirmedAt: now.toISOString() });
      const again = await completeWalletSignIn({
        address: ALICE,
        chainId: 1,
        ageConfirmed: false,
        secret: SECRET,
        now: new Date("2026-10-09T16:00:00.000Z"),
      });
      assert.equal(again.ok, true);
      if (!again.ok) return;
      assert.equal(again.confirmedAt, now.toISOString());
      const reread = JSON.parse(readFileSync(store.file, "utf8")) as {
        people: { ageConfirmedAt?: string }[];
      };
      assert.equal(reread.people[0]?.ageConfirmedAt, now.toISOString());
    } finally {
      store.restore();
    }
  });

  it("the verify route sets no session cookie when confirmation is missing", async () => {
    const store = useFile();
    try {
      const account = privateKeyToAccount(
        "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      );
      const { nonce, token } = await issueNonce(SECRET);
      const message = buildSiweMessage({
        domain: "localhost:3000",
        address: account.address,
        uri: "http://localhost:3000",
        chainId: 1,
        nonce,
        expirationTime: new Date(Date.now() + 60_000),
      });
      const signature = await account.signMessage({ message });
      const response = await verifySignIn(
        new Request("http://localhost:3000/api/identity/verify", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: `${nonceCookieName(false)}=${token}`,
          },
          body: JSON.stringify({ message, signature }),
        }),
      );
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: AGE_CONFIRMATION_REQUIRED });
      assert.equal(response.headers.getSetCookie().length, 0);
      let raw = "";
      try {
        raw = readFileSync(store.file, "utf8");
      } catch {
        raw = "";
      }
      assert.equal(raw.includes("ageConfirmedAt"), false);
    } finally {
      store.restore();
    }
  });
});

describe("age confirmation on first OAuth sign-in", () => {
  it("withholds the backup session until the confirmation is stored", async () => {
    const store = useFile();
    const env = { S3RCH_OAUTH_ISSUER: ISSUER, NODE_ENV: "test" };
    try {
      const { publicKey, privateKey } = await generateKeyPair("RS256");
      async function callback() {
        const started = await beginOAuth(
          new Request("http://127.0.0.1:3000/api/identity/oauth/start?idp=github", {
            headers: { "x-forwarded-proto": "http" },
          }),
          env,
        );
        const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? "";
        const pkce = started.headers.getSetCookie().find((row) => row.startsWith(`${oauthPkceCookieName(false)}=`));
        assert.ok(pkce);
        const idToken = await new SignJWT({ idp_provider: "github" })
          .setProtectedHeader({ alg: "RS256" })
          .setIssuer(ISSUER)
          .setAudience(OAUTH_CLIENT_ID)
          .setSubject("kc-age")
          .setExpirationTime("5m")
          .sign(privateKey);
        return finishOAuth(
          new Request(`http://127.0.0.1:3000/api/identity/oauth/callback?code=auth-code&state=${state}`, {
            headers: { cookie: pkce.split(";")[0] ?? "", "x-forwarded-proto": "http" },
          }),
          env,
          { key: publicKey, fetchImpl: async () => Response.json({ id_token: idToken }) },
        );
      }

      const first = await callback();
      assert.equal(first.status, 302);
      assert.equal(first.headers.get("location"), "/feed?oauth=age");
      assert.equal(sessionCookie(first), undefined);
      assert.ok(first.headers.getSetCookie().some((row) => row.startsWith(`${oauthAgeCookieName(false)}=`)));
      let pendingFile = "";
      try {
        pendingFile = readFileSync(store.file, "utf8");
      } catch {
        pendingFile = "";
      }
      assert.equal(pendingFile.includes("kc-age"), false);

      const ageCookie = first.headers
        .getSetCookie()
        .find((row) => row.startsWith(`${oauthAgeCookieName(false)}=`))
        ?.split(";")[0];
      assert.ok(ageCookie);
      const refused = await acceptOAuthAge(
        new Request("http://127.0.0.1:3000/api/identity/oauth/age", {
          method: "POST",
          headers: { cookie: ageCookie, "content-type": "application/json", "x-forwarded-proto": "http" },
          body: JSON.stringify({ ageConfirmed: false }),
        }),
        env,
      );
      assert.equal(refused.status, 403);
      assert.equal(sessionCookie(refused), undefined);
      assert.deepEqual(await refused.json(), { error: AGE_CONFIRMATION_REQUIRED });

      const accepted = await acceptOAuthAge(
        new Request("http://127.0.0.1:3000/api/identity/oauth/age", {
          method: "POST",
          headers: { cookie: ageCookie, "content-type": "application/json", "x-forwarded-proto": "http" },
          body: JSON.stringify({ ageConfirmed: true }),
        }),
        env,
        Date.parse(STAMP),
      );
      assert.equal(accepted.status, 200);
      const baked = sessionCookie(accepted);
      assert.ok(baked);
      const token = decodeURIComponent((baked.split(";")[0] ?? "").slice(baked.indexOf("=") + 1));
      const claims = await readBackupSession(token, SECRET);
      assert.equal(claims.sub, "kc-age");
      const saved = JSON.parse(readFileSync(store.file, "utf8")) as {
        oauthAge?: { sub: string; confirmedAt: string }[];
      };
      assert.equal(saved.oauthAge?.[0]?.sub, "kc-age");
      assert.equal(saved.oauthAge?.[0]?.confirmedAt, STAMP);

      const again = await callback();
      assert.equal(again.headers.get("location"), "/feed");
      assert.ok(sessionCookie(again));
      assert.equal(again.headers.get("location")?.includes("oauth=age"), false);
    } finally {
      store.restore();
    }
  });
});

describe("age confirmation copy", () => {
  it("uses the confirmation sentence only on the confirmation control", () => {
    const shown = renderToStaticMarkup(
      createElement(AgeConfirmation, { checked: false, onChange() {} }),
    );
    assert.match(shown, new RegExp(AGE_CONFIRMATION_LABEL));
    const signIn = renderToStaticMarkup(
      createElement(SignInOptions, {
        connected: true,
        address: "0xf39F…2266",
        pending: false,
        walletConnectAvailable: false,
        smartWalletAvailable: false,
        useExistingWallet: false,
        onConnect() {},
        onWalletConnect() {},
        onPasskeyWallet() {},
        onSignIn() {},
        onUseExisting() {},
        onDeclineExisting() {},
      }),
    );
    assert.equal(signIn.includes(AGE_CONFIRMATION_LABEL), false);
  });

  it("rejects a confirmation time that is not a timestamp", () => {
    const parsed = parseLinkFile({
      v: 1,
      people: [
        {
          owner: ALICE,
          handles: [{ kind: "wallet", address: ALICE }],
          ageConfirmedAt: "yesterday",
        },
      ],
    });
    assert.equal(parsed.ok, false);
  });
});

describe("age confirmation in blob storage", () => {
  it("a second process reads the link and the confirmation", () => {
    const dir = mkdtempSync(join(tmpdir(), "s3rch-age-blob-"));
    const moduleUrl = new URL("./link.ts", import.meta.url).href;
    const clientUrl = new URL("./directory-blob-client.ts", import.meta.url).href;
    const tsx = createRequire(import.meta.url).resolve("tsx");
    const stamp = "2026-10-09T15:04:05.000Z";
    const later = "2026-10-09T16:00:00.000Z";
    const run = (cwd: string, program: string) => {
      const result = spawnSync(process.execPath, ["--import", tsx, "--input-type=module", "-e", `
        import { BlobLinkStore, openLinks } from ${JSON.stringify(moduleUrl)};
        import { directoryBlobClient } from ${JSON.stringify(clientUrl)};
        const links = openLinks(new BlobLinkStore(directoryBlobClient(${JSON.stringify(dir)})));
        ${program}
      `], { cwd, env: { ...process.env, NODE_ENV: "test" }, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    };
    try {
      const first = join(dir, "old-container");
      const replacement = join(dir, "new-container");
      mkdirSync(first);
      mkdirSync(replacement);
      run(first, `
        const linked = links.link({ wallet: ${JSON.stringify(ALICE)}, sub: "kc-age", idp: "github" });
        if (linked.denied) process.exit(1);
        const saved = links.saveWalletAge(${JSON.stringify(ALICE)}, ${JSON.stringify(stamp)});
        if (!("confirmedAt" in saved) || saved.confirmedAt !== ${JSON.stringify(stamp)}) process.exit(2);
      `);
      run(replacement, `
        if (links.ownerForOAuth("kc-age") !== ${JSON.stringify(ALICE)}) process.exit(3);
        const status = links.ageStatusForWallet(${JSON.stringify(ALICE)});
        if (!("confirmedAt" in status) || status.confirmedAt !== ${JSON.stringify(stamp)}) process.exit(4);
        const again = links.saveWalletAge(${JSON.stringify(ALICE)}, ${JSON.stringify(later)});
        if (!("confirmedAt" in again) || again.confirmedAt !== ${JSON.stringify(stamp)}) process.exit(5);
      `);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
