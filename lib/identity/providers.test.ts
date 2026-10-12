import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateKeyPair, SignJWT } from "jose";
import { oauthPkceCookieName } from "./cookies";
import { beginOAuth, finishOAuth } from "./oauth";
import {
  findOidcProvider,
  normalizeProviderUrl,
  providerSubject,
  publicLoginProviders,
  readLoginProviders,
} from "./providers";

const OTHER = {
  id: "partner",
  kind: "oidc",
  label: "Partner org",
  issuer: "https://login.partner.example/realms/main",
  clientId: "s3rch",
};

function listEnv(entries: unknown[]): Record<string, string> {
  return { S3RCH_LOGIN_PROVIDERS: JSON.stringify(entries), NODE_ENV: "test" };
}

describe("login provider list", () => {
  it("defaults to SIWE only when nothing is configured", () => {
    assert.deepEqual(readLoginProviders({}), {
      providers: [{ id: "siwe", kind: "siwe", label: "Wallet" }],
      errors: [],
    });
  });

  it("adds the default OIDC provider from S3RCH_OAUTH_ISSUER", () => {
    const { providers } = readLoginProviders({
      S3RCH_OAUTH_ISSUER: "https://auth.example.org/realms/controlplane/",
      S3RCH_OAUTH_WALLET_URL: "https://api.example.org/auth/siwe/me",
    });
    assert.equal(providers.length, 2);
    const oidc = providers[1];
    assert.equal(oidc.kind, "oidc");
    if (oidc.kind !== "oidc") return;
    assert.equal(oidc.id, "panopticon");
    assert.equal(oidc.issuer, "https://auth.example.org/realms/controlplane");
    assert.equal(oidc.clientId, "s3rch-web");
    assert.equal(oidc.walletLookupUrl, "https://api.example.org/auth/siwe/me");
    assert.equal(oidc.tokenEndpoint, "https://auth.example.org/realms/controlplane/protocol/openid-connect/token");
  });

  it("reads an explicit list and always keeps SIWE", () => {
    const { providers, errors } = readLoginProviders(listEnv([OTHER]));
    assert.deepEqual(providers.map((p) => p.id), ["siwe", "partner"]);
    assert.equal(errors.length, 1);
  });

  it("drops invalid entries instead of trusting them", () => {
    const { providers, errors } = readLoginProviders(
      listEnv([
        { id: "siwe", kind: "siwe" },
        { id: "plain", kind: "oidc", issuer: "http://login.example.org" },
        { id: "Bad Id", kind: "oidc", issuer: "https://login.example.org" },
        { id: "partner", kind: "saml", issuer: "https://login.example.org" },
        OTHER,
        OTHER,
      ]),
    );
    assert.deepEqual(providers.map((p) => p.id), ["siwe", "partner"]);
    assert.equal(errors.length, 4);
  });

  it("treats malformed JSON as SIWE only", () => {
    const result = readLoginProviders({ S3RCH_LOGIN_PROVIDERS: "{" });
    assert.deepEqual(result.providers.map((p) => p.id), ["siwe"]);
    assert.match(result.errors[0], /not valid JSON/);
  });

  it("allows custom endpoints for non-Keycloak providers", () => {
    const provider = findOidcProvider(
      listEnv([
        {
          ...OTHER,
          authorizationEndpoint: "https://login.partner.example/oauth2/authorize",
          tokenEndpoint: "https://login.partner.example/oauth2/token",
          jwksUri: "https://login.partner.example/oauth2/keys",
        },
      ]),
    );
    assert.equal(provider?.authorizationEndpoint, "https://login.partner.example/oauth2/authorize");
    assert.equal(provider?.jwksUri, "https://login.partner.example/oauth2/keys");
  });

  it("normalizes URLs and refuses credentials, queries and plain http", () => {
    assert.equal(normalizeProviderUrl("https://a.example/x/"), "https://a.example/x");
    assert.equal(normalizeProviderUrl("http://localhost:8081/realms/x"), "http://localhost:8081/realms/x");
    assert.equal(normalizeProviderUrl("http://a.example"), null);
    assert.equal(normalizeProviderUrl("https://u:p@a.example"), null);
    assert.equal(normalizeProviderUrl("https://a.example/#x"), null);
  });

  it("namespaces subjects per provider and blocks look-alike default subjects", () => {
    assert.equal(providerSubject({ id: "panopticon" }, "abc"), "abc");
    assert.equal(providerSubject({ id: "partner" }, "abc"), "partner:abc");
    assert.equal(providerSubject({ id: "panopticon" }, "partner:abc"), null);
    // Also after that provider is removed from the config.
    assert.equal(providerSubject({ id: "panopticon" }, "retired-org:abc"), null);
    assert.equal(providerSubject({ id: "panopticon" }, "f81d4fae-7dec-11d0-a765-00a0c91e6bf6"), "f81d4fae-7dec-11d0-a765-00a0c91e6bf6");
  });

  it("refuses namespaced subjects over the store limit", () => {
    assert.equal(providerSubject({ id: "partner" }, "x".repeat(248)), `partner:${"x".repeat(248)}`);
    assert.equal(providerSubject({ id: "partner" }, "x".repeat(249)), null);
  });

  it("reserves the siwe id for wallet sign-in", () => {
    const { providers, errors } = readLoginProviders(
      listEnv([{ id: "siwe", kind: "oidc", issuer: "https://login.example.org" }, { id: "wallet", kind: "siwe" }]),
    );
    assert.deepEqual(providers.map((p) => p.id), ["siwe"]);
    assert.equal(providers[0].kind, "siwe");
    assert.ok(errors.some((e) => /reserved/.test(e)));
  });

  it("keeps explicit endpoints exactly as written", () => {
    const provider = findOidcProvider(listEnv([{ ...OTHER, tokenEndpoint: "https://login.partner.example/oauth/token/" }]));
    assert.equal(provider?.tokenEndpoint, "https://login.partner.example/oauth/token/");
  });

  it("keeps an explicit issuer exactly, including a trailing slash", () => {
    const provider = findOidcProvider(listEnv([{ ...OTHER, issuer: "https://login.example.org/tenant/" }]));
    assert.equal(provider?.issuer, "https://login.example.org/tenant/");
    assert.equal(provider?.tokenEndpoint, "https://login.example.org/tenant/protocol/openid-connect/token");
  });

  it("exposes ids, kinds and labels only", () => {
    assert.deepEqual(publicLoginProviders(listEnv([{ id: "siwe", kind: "siwe" }, OTHER])), [
      { id: "siwe", kind: "siwe", label: "Wallet" },
      { id: "partner", kind: "oidc", label: "Partner org" },
    ]);
  });
});

describe("OAuth flow with a second provider", () => {
  it("sends the browser to the chosen provider and verifies its token", async () => {
    const env = listEnv([
      { id: "siwe", kind: "siwe" },
      { id: "panopticon", kind: "oidc", issuer: "https://auth.example.org/realms/controlplane" },
      OTHER,
    ]);
    const started = await beginOAuth(
      new Request("http://127.0.0.1:3000/api/identity/oauth/start?provider=partner"),
      env,
    );
    const location = new URL(started.headers.get("location") ?? "");
    assert.equal(location.origin + location.pathname, "https://login.partner.example/realms/main/protocol/openid-connect/auth");
    assert.equal(location.searchParams.get("client_id"), "s3rch");
    const state = location.searchParams.get("state") ?? "";
    const pkce = (started.headers.getSetCookie().find((row) => row.startsWith(`${oauthPkceCookieName(false)}=`)) ?? "").split(";")[0];

    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const idToken = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(OTHER.issuer)
      .setAudience("s3rch")
      .setSubject("user-7")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    let tokenUrl = "";
    const finished = await finishOAuth(
      new Request(`http://127.0.0.1:3000/api/identity/oauth/callback?code=c&state=${state}`, {
        headers: { cookie: pkce },
      }),
      env,
      {
        key: publicKey,
        fetchImpl: async (url) => {
          tokenUrl = String(url);
          return Response.json({ id_token: idToken });
        },
      },
    );
    assert.equal(tokenUrl, "https://login.partner.example/realms/main/protocol/openid-connect/token");
    assert.equal(finished.status, 302);
    assert.notEqual(finished.headers.get("location"), "/feed?oauth=denied");
  });

  it("sends a legacy PKCE cookie only to the default provider", async () => {
    const { SignJWT } = await import("jose");
    const { secretKey } = await import("./secret");
    const { LOCAL_SESSION_SECRET } = await import("./config");
    const iat = Math.floor(Date.now() / 1000);
    const legacy = await new SignJWT({
      kind: "oauth-pkce",
      state: "s".repeat(43),
      verifier: "v".repeat(43),
      redirectUri: "http://127.0.0.1:3000/api/identity/oauth/callback",
      idp: "",
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject("oauth-pkce")
      .setIssuedAt(iat)
      .setExpirationTime(iat + 600)
      .sign(secretKey(LOCAL_SESSION_SECRET));
    const seen: string[] = [];
    const request = () =>
      new Request(`http://127.0.0.1:3000/api/identity/oauth/callback?code=c&state=${"s".repeat(43)}`, {
        headers: { cookie: `${oauthPkceCookieName(false)}=${legacy}` },
      });
    const fetchImpl = async (url: string | URL | Request) => {
      seen.push(String(url));
      return new Response("no", { status: 400 });
    };
    // Partner first, panopticon absent: denied without contacting anyone.
    const denied = await finishOAuth(request(), listEnv([OTHER]), { fetchImpl });
    assert.equal(denied.headers.get("location"), "/feed?oauth=denied");
    assert.deepEqual(seen, []);
    // Partner first, panopticon present: the code goes to panopticon.
    await finishOAuth(
      request(),
      listEnv([OTHER, { id: "panopticon", kind: "oidc", issuer: "https://auth.example.org/realms/controlplane" }]),
      { fetchImpl },
    );
    assert.deepEqual(seen, ["https://auth.example.org/realms/controlplane/protocol/openid-connect/token"]);
  });

  it("refuses an unknown provider id", async () => {
    const started = await beginOAuth(
      new Request("http://127.0.0.1:3000/api/identity/oauth/start?provider=nope"),
      listEnv([OTHER]),
    );
    assert.equal(started.headers.get("location"), "/feed?oauth=denied");
  });

  it("reports unconfigured when no OIDC provider exists", async () => {
    const started = await beginOAuth(new Request("http://127.0.0.1:3000/api/identity/oauth/start"), { NODE_ENV: "test" });
    assert.equal(started.headers.get("location"), "/feed?oauth=unconfigured");
  });
});
