import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SignInOptions } from "../../components/SignInOptions";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { generateKeyPair, SignJWT } from "jose";
import { LOCAL_SESSION_SECRET, OAUTH_CLIENT_ID, OAUTH_REDIRECT_URIS } from "./config";
import { oauthPkceCookieName, oauthSessionCookieName, sessionCookieName } from "./cookies";
import { linkLoginPaths, ownerForOAuth } from "./link";
import { readSessionToken, signSessionToken } from "./session";
import {
  ALLOWED_OAUTH_ISSUERS,
  beginOAuth,
  buildAuthorizeUrl,
  callbackUriFor,
  createPkcePair,
  exchangeCodeForIdToken,
  finishOAuth,
  lookupHypermeshWallet,
  parseIdpHint,
  readBackupSession,
  readOAuthIssuer,
  signBackupSession,
} from "./oauth";

const ISSUER = "https://auth.test.hyperme.sh/realms/controlplane";
const SECRET = LOCAL_SESSION_SECRET;
const ENV = { S3RCH_OAUTH_ISSUER: ISSUER, NODE_ENV: "test" };

function startRequest(url: string, proto = "http"): Request {
  return new Request(url, { headers: { "x-forwarded-proto": proto } });
}

function cookiePair(response: Response, name: string): string {
  const rows = response.headers.getSetCookie();
  const row = rows.find((item) => item.startsWith(`${name}=`));
  assert.ok(row, `missing ${name}`);
  return row.split(";")[0] ?? "";
}

describe("OAuth config fails closed", () => {
  it("accepts only the known controlplane issuers", () => {
    assert.equal(readOAuthIssuer({}), null);
    assert.equal(readOAuthIssuer({ S3RCH_OAUTH_ISSUER: "https://evil.example/realms/controlplane" }), null);
    assert.equal(readOAuthIssuer({ S3RCH_OAUTH_ISSUER: `${ISSUER}/` }), ISSUER);
    assert.equal(readOAuthIssuer({ S3RCH_OAUTH_ISSUER: "http://127.0.0.1:8081/realms/controlplane" }), ALLOWED_OAUTH_ISSUERS[3]);
  });

  it("allows only the declared callback URIs", () => {
    assert.deepEqual(
      [...OAUTH_REDIRECT_URIS],
      [
        "https://s3r.ch/api/identity/oauth/callback",
        "https://www.s3r.ch/api/identity/oauth/callback",
        "http://localhost:3000/api/identity/oauth/callback",
        "http://127.0.0.1:3000/api/identity/oauth/callback",
      ],
    );
    assert.equal(callbackUriFor("s3r.ch", true), OAUTH_REDIRECT_URIS[0]);
    assert.equal(callbackUriFor("www.s3r.ch", true), OAUTH_REDIRECT_URIS[1]);
    assert.equal(callbackUriFor("localhost:3000", false), OAUTH_REDIRECT_URIS[2]);
    assert.equal(callbackUriFor("evil.example", true), null);
    assert.equal(callbackUriFor("s3r.ch", false), null);
    assert.equal(callbackUriFor("localhost:3001", false), null);
  });

  it("accepts the three existing brokers and nothing else", () => {
    assert.equal(parseIdpHint(null), null);
    assert.equal(parseIdpHint("github"), "github");
    assert.equal(parseIdpHint("apple"), "invalid");
    assert.equal(parseIdpHint("microsoft "), "invalid");
  });
});

describe("OAuth start", () => {
  it("redirects home when the issuer is unset", async () => {
    const response = await beginOAuth(
      startRequest("http://localhost:3000/api/identity/oauth/start?idp=google"),
      { NODE_ENV: "test" },
    );
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/feed?oauth=unconfigured");
    assert.equal(response.headers.getSetCookie().length, 0);
  });

  it("sends PKCE and the broker hint, and does not use the SIWE cookie", async () => {
    const response = await beginOAuth(
      startRequest("http://localhost:3000/api/identity/oauth/start?idp=microsoft"),
      ENV,
    );
    assert.equal(response.status, 302);
    const location = response.headers.get("location") ?? "";
    const url = new URL(location);
    assert.equal(url.origin + url.pathname, `${ISSUER}/protocol/openid-connect/auth`);
    assert.equal(url.searchParams.get("client_id"), OAUTH_CLIENT_ID);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("kc_idp_hint"), "microsoft");
    assert.equal(url.searchParams.get("scope"), "openid");
    assert.equal(location.includes("client_secret"), false);
    const pair = cookiePair(response, oauthPkceCookieName(false));
    assert.equal(pair.startsWith(`${sessionCookieName(false)}=`), false);
    assert.match(response.headers.getSetCookie()[0] ?? "", /HttpOnly/);
  });

  it("refuses a host that is not a registered redirect", async () => {
    const response = await beginOAuth(
      startRequest("https://evil.example/api/identity/oauth/start", "https"),
      ENV,
    );
    assert.equal(response.headers.get("location"), "/feed?oauth=denied");
  });
});

describe("OAuth callback", () => {
  it("sets a backup session and drops the provider tokens", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const started = await beginOAuth(
      startRequest("http://127.0.0.1:3000/api/identity/oauth/start?idp=github"),
      ENV,
    );
    const authorize = new URL(started.headers.get("location") ?? "");
    const state = authorize.searchParams.get("state") ?? "";
    const challenge = authorize.searchParams.get("code_challenge") ?? "";
    const pkce = cookiePair(started, oauthPkceCookieName(false));
    const idToken = await new SignJWT({ idp_provider: "github" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(ISSUER)
      .setAudience(OAUTH_CLIENT_ID)
      .setSubject("kc-user-1")
      .setExpirationTime("5m")
      .sign(privateKey);

    let tokenBody = "";
    const response = await finishOAuth(
      new Request(
        `http://127.0.0.1:3000/api/identity/oauth/callback?code=auth-code&state=${state}`,
        { headers: { cookie: pkce, "x-forwarded-proto": "http" } },
      ),
      ENV,
      {
        key: publicKey,
        fetchImpl: async (_url, init) => {
          tokenBody = String(init?.body ?? "");
          return Response.json({
            id_token: idToken,
            access_token: "provider-access-token",
            refresh_token: "provider-refresh-token",
          });
        },
      },
    );

    assert.equal(tokenBody.includes("client_secret"), false);
    assert.match(tokenBody, /code_verifier=/);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/feed");
    const baked = response.headers.getSetCookie().join("\n");
    assert.equal(baked.includes("provider-access-token"), false);
    assert.equal(baked.includes("provider-refresh-token"), false);
    assert.equal(baked.includes(idToken), false);
    const sessionPair = cookiePair(response, oauthSessionCookieName(false));
    const token = decodeURIComponent(sessionPair.slice(sessionPair.indexOf("=") + 1));
    const claims = await readBackupSession(token, SECRET);
    assert.equal(claims.sub, "kc-user-1");
    assert.equal(claims.idp, "github");
    assert.equal("address" in claims, false);
    const pkcePayload = JSON.parse(
      Buffer.from(pkce.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as { verifier?: string };
    assert.equal(typeof pkcePayload.verifier, "string");
    assert.equal(
      createHash("sha256").update(pkcePayload.verifier ?? "").digest("base64url"),
      challenge,
    );

    const route = readFileSync(
      new URL("../../app/api/identity/oauth/session/route.ts", import.meta.url),
      "utf8",
    );
    assert.match(route, /linked: owner !== null/);
    assert.equal(route.includes("session.sub"), false);
    assert.equal(route.includes("sub:"), false);
    assert.equal(route.includes("kc-user-1"), false);
  });

  it("does not call the token endpoint when state does not match", async () => {
    const started = await beginOAuth(
      startRequest("http://localhost:3000/api/identity/oauth/start"),
      ENV,
    );
    const pkce = cookiePair(started, oauthPkceCookieName(false));
    let called = false;
    const response = await finishOAuth(
      new Request("http://localhost:3000/api/identity/oauth/callback?code=x&state=nope", {
        headers: { cookie: pkce },
      }),
      ENV,
      {
        fetchImpl: async () => {
          called = true;
          return Response.json({});
        },
      },
    );
    assert.equal(called, false);
    assert.equal(response.headers.get("location"), "/feed?oauth=denied");
    assert.equal(
      response.headers.getSetCookie().some((row) => row.startsWith(`${oauthSessionCookieName(false)}=`)),
      false,
    );
  });

  it("rejects an id token for another client", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const started = await beginOAuth(startRequest("http://localhost:3000/api/identity/oauth/start"), ENV);
    const state = new URL(started.headers.get("location") ?? "").searchParams.get("state");
    const pkce = cookiePair(started, oauthPkceCookieName(false));
    const idToken = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(ISSUER)
      .setAudience("controlplane-frontend")
      .setSubject("kc-user-1")
      .setExpirationTime("5m")
      .sign(privateKey);
    const response = await finishOAuth(
      new Request(`http://localhost:3000/api/identity/oauth/callback?code=auth-code&state=${state}`, {
        headers: { cookie: pkce },
      }),
      ENV,
      {
        key: publicKey,
        fetchImpl: async () => Response.json({ id_token: idToken }),
      },
    );
    assert.equal(response.headers.get("location"), "/feed?oauth=denied");
  });

  it("links a SIWE cookie already on the callback and reports a conflict", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const dir = mkdtempSync(join(tmpdir(), "s3rch-oauth-link-"));
    const file = join(dir, "identity-links.json");
    const previous = process.env.S3RCH_IDENTITY_LINKS;
    process.env.S3RCH_IDENTITY_LINKS = file;
    const alice = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
    const bob = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    try {
      const siwe = await signSessionToken({ address: alice, chainId: 1 }, SECRET);
      const started = await beginOAuth(
        startRequest("http://127.0.0.1:3000/api/identity/oauth/start"),
        ENV,
      );
      const state = new URL(started.headers.get("location") ?? "").searchParams.get("state");
      const pkce = cookiePair(started, oauthPkceCookieName(false));
      const idToken = await new SignJWT({})
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer(ISSUER)
        .setAudience(OAUTH_CLIENT_ID)
        .setSubject("kc-link-1")
        .setExpirationTime("5m")
        .sign(privateKey);
      const response = await finishOAuth(
        new Request(`http://127.0.0.1:3000/api/identity/oauth/callback?code=auth-code&state=${state}`, {
          headers: {
            cookie: `${sessionCookieName(false)}=${siwe}; ${pkce}`,
            "x-forwarded-proto": "http",
          },
        }),
        ENV,
        {
          key: publicKey,
          fetchImpl: async () => Response.json({ id_token: idToken }),
        },
      );
      assert.equal(response.headers.get("location"), "/feed");
      assert.equal(ownerForOAuth("kc-link-1"), alice);

      linkLoginPaths({ wallet: bob, sub: "kc-other", idp: "google" });
      const conflictStart = await beginOAuth(
        startRequest("http://127.0.0.1:3000/api/identity/oauth/start"),
        ENV,
      );
      const conflictState = new URL(conflictStart.headers.get("location") ?? "").searchParams.get("state");
      const conflictPkce = cookiePair(conflictStart, oauthPkceCookieName(false));
      const other = await new SignJWT({})
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer(ISSUER)
        .setAudience(OAUTH_CLIENT_ID)
        .setSubject("kc-other")
        .setExpirationTime("5m")
        .sign(privateKey);
      const conflict = await finishOAuth(
        new Request(
          `http://127.0.0.1:3000/api/identity/oauth/callback?code=auth-code&state=${conflictState}`,
          {
            headers: {
              cookie: `${sessionCookieName(false)}=${siwe}; ${conflictPkce}`,
              "x-forwarded-proto": "http",
            },
          },
        ),
        ENV,
        {
          key: publicKey,
          fetchImpl: async () => Response.json({ id_token: other }),
        },
      );
      assert.equal(conflict.headers.get("location"), "/feed?oauth=conflict");
      assert.equal(ownerForOAuth("kc-other"), bob);
      assert.equal(ownerForOAuth("kc-link-1"), alice);
    } finally {
      if (previous === undefined) delete process.env.S3RCH_IDENTITY_LINKS;
      else process.env.S3RCH_IDENTITY_LINKS = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("backup session is not the SIWE session", () => {
  it("roundtrips sub and broker, and refuses an address-shaped subject", async () => {
    const token = await signBackupSession({ sub: "kc-user-1", idp: "google" }, SECRET);
    const claims = await readBackupSession(token, SECRET);
    assert.equal(claims.sub, "kc-user-1");
    assert.equal(claims.idp, "google");
    await assert.rejects(() =>
      signBackupSession(
        { sub: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", idp: null },
        SECRET,
      ),
    );
    await assert.rejects(() => readSessionToken(token, SECRET));
  });

  it("refuses a SIWE cookie presented as the backup cookie", async () => {
    const siwe = await signSessionToken(
      { address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", chainId: 1 },
      SECRET,
    );
    await assert.rejects(() => readBackupSession(siwe, SECRET));
  });
});

describe("hyperme.sh wallet handoff", () => {
  it("reads the bound address and does not keep the access token", async () => {
    const wallet = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
    let auth = "";
    const found = await lookupHypermeshWallet({
      issuer: ISSUER,
      accessToken: "provider-access-token",
      fetchImpl: async (url, init) => {
        const headers = init?.headers as { Authorization?: string } | undefined;
        auth = headers?.Authorization ?? "";
        assert.equal(url, "https://api.test.hyperme.sh/auth/siwe/me");
        return Response.json({ bound: true, wallet_address: wallet.toLowerCase() });
      },
    });
    assert.equal(found, wallet);
    assert.equal(auth, "Bearer provider-access-token");
    assert.equal(
      await lookupHypermeshWallet({
        issuer: ISSUER,
        accessToken: "provider-access-token",
        fetchImpl: async () => new Response("missing", { status: 404 }),
      }),
      null,
    );
    assert.equal(
      await lookupHypermeshWallet({
        issuer: "http://127.0.0.1:8081/realms/controlplane",
        accessToken: "provider-access-token",
        fetchImpl: async () => {
          throw new Error("localhost has no wallet URL");
        },
      }),
      null,
    );
    assert.equal(
      await lookupHypermeshWallet({
        issuer: ISSUER,
        accessToken: "provider-access-token",
        fetchImpl: async () =>
          Response.json({
            bound: true,
            wallet_address: "FyberHmHostUsdc111111111111111111111111111",
          }),
      }),
      null,
    );

    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const started = await beginOAuth(
      startRequest("http://127.0.0.1:3000/api/identity/oauth/start?idp=github"),
      ENV,
    );
    const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const pkce = cookiePair(started, oauthPkceCookieName(false));
    const idToken = await new SignJWT({ idp_provider: "github" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(ISSUER)
      .setAudience(OAUTH_CLIENT_ID)
      .setSubject("kc-user-1")
      .setExpirationTime("5m")
      .sign(privateKey);
    const response = await finishOAuth(
      new Request(
        `http://127.0.0.1:3000/api/identity/oauth/callback?code=auth-code&state=${state}`,
        { headers: { cookie: pkce, "x-forwarded-proto": "http" } },
      ),
      ENV,
      {
        key: publicKey,
        fetchImpl: async () =>
          Response.json({
            id_token: idToken,
            access_token: "provider-access-token",
            refresh_token: "provider-refresh-token",
          }),
        walletFetch: async () => Response.json({ bound: true, wallet_address: wallet }),
      },
    );
    const baked = response.headers.getSetCookie().join("\n");
    assert.equal(baked.includes("provider-access-token"), false);
    assert.equal(baked.includes("provider-refresh-token"), false);
    const sessionPair = cookiePair(response, oauthSessionCookieName(false));
    const token = decodeURIComponent(sessionPair.slice(sessionPair.indexOf("=") + 1));
    const claims = await readBackupSession(token, SECRET);
    assert.equal(claims.hypermeshWallet, wallet);
    assert.equal("address" in claims, false);
  });
});

describe("token exchange", () => {
  it("posts the verifier and omits a client secret", async () => {
    const pair = createPkcePair();
    let seen = "";
    const idToken = await exchangeCodeForIdToken(
      {
        issuer: ISSUER,
        code: "auth-code",
        verifier: pair.verifier,
        redirectUri: OAUTH_REDIRECT_URIS[2],
      },
      async (_url, init) => {
        seen = String(init?.body ?? "");
        return Response.json({ id_token: "header.payload.sig", access_token: "nope" });
      },
    );
    assert.equal(idToken, "header.payload.sig");
    assert.match(seen, new RegExp(`code_verifier=${pair.verifier}`));
    assert.match(seen, /client_id=s3rch-web/);
    assert.equal(seen.includes("client_secret"), false);
    assert.equal(seen.includes("nope"), false);
  });

  it("builds an authorize URL without a secret", () => {
    const url = buildAuthorizeUrl({
      issuer: ISSUER,
      redirectUri: OAUTH_REDIRECT_URIS[0],
      state: "state",
      challenge: "challenge",
      idp: null,
    });
    assert.equal(url.includes("client_secret"), false);
    assert.equal(url.includes("kc_idp_hint"), false);
  });
});

describe("OAuth stays off Gun and off the SIWE owner", () => {
  it("does not mention Gun or a client secret", () => {
    const src = readFileSync(new URL("./oauth.ts", import.meta.url), "utf8");
    assert.equal(src.includes("client_secret"), false);
    assert.equal(src.includes("refresh_token"), false);
    const sessionFn = src.slice(
      src.indexOf("export async function signBackupSession"),
      src.indexOf("export async function readBackupSession"),
    );
    assert.equal(sessionFn.includes("access_token"), false);
    assert.equal(src.includes('from "gun"'), false);
    assert.match(src, /written to Gun/);
    const forum = readFileSync(new URL("../forum.ts", import.meta.url), "utf8");
    assert.equal(forum.includes("oauth"), false);
    const bar = renderToStaticMarkup(createElement(SignInOptions, {
      connected: false, address: "", pending: false,
      walletConnectAvailable: false, smartWalletAvailable: true,
      useExistingWallet: false,
      onConnect() {}, onWalletConnect() {}, onPasskeyWallet() {},
      onSignIn() {}, onUseExisting() {}, onDeclineExisting() {},
    }));
    assert.match(bar, /Browser wallet/);
    assert.match(bar, /Continue with Microsoft/);
    for (const idp of ["microsoft", "github", "google"]) {
      assert.ok(bar.includes(`href="/api/identity/oauth/start?idp=${idp}"`));
    }
    assert.match(bar, /href="\/api\/identity\/oauth\/start"/);
    assert.match(bar, /Continue with Hypermesh/);
    assert.equal(bar.includes("Sign in with wallet"), false);
    assert.equal(bar.includes("WalletConnect"), false);
  });
});
