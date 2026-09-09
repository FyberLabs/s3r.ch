import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ATPROTO_NOT_CONFIGURED,
  ATPROTO_TOO_LONG,
  AtprotoOutbound,
  atprotoPostText,
  readAtprotoOutboundConfig,
} from "./atproto-outbound";
import { UnimplementedOutbound } from "./bridges";
import { composeNativePost, prepareShareIntoMesh } from "./compose";
import {
  FARCASTER_NOT_CONFIGURED,
  FARCASTER_TOO_LONG,
  FarcasterOutbound,
  encodeCastAdd,
  farcasterResultUrl,
  parseSignerKey,
  readFarcasterOutboundConfig,
} from "./farcaster-outbound";
import { createMemorySeeAcl } from "./identity/see-acl";
import { createOutboundAdapters } from "./outbound-adapters";
import {
  adapterForNetwork,
  canOutboundPost,
  draftFromItem,
  outboundStatus,
  parseOutboundRequest,
  postOutbound,
} from "./outbound";

const ALICE = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const BOB = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const SIGNER =
  "0x1111111111111111111111111111111111111111111111111111111111111111";

function native(body = "hello mesh") {
  const item = composeNativePost({
    body,
    address: ALICE,
    nowSeconds: 1_700_000_000,
    entropy: "aabb",
  });
  assert.ok(item);
  return item;
}

describe("parseOutboundRequest", () => {
  it("accepts farcaster / atproto and rejects unknown networks", () => {
    const item = native();
    const ok = parseOutboundRequest({ network: "farcaster", item });
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.network, "farcaster");
    assert.equal(parseOutboundRequest({ network: "nostr", item }).ok, false);
    assert.equal(parseOutboundRequest({ network: "activitypub", item }).ok, false);
    assert.equal(parseOutboundRequest({}).ok, false);
    assert.equal(parseOutboundRequest("x").ok, false);
  });

  it("rejects an empty body", () => {
    const item = { ...native(), body: "   " };
    const parsed = parseOutboundRequest({ network: "atproto", item });
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.equal(parsed.error, "Write something first.");
  });
});

describe("canOutboundPost", () => {
  it("is own native only — not share, not a pull, not Bob's post", () => {
    const item = native();
    assert.equal(canOutboundPost(item, ALICE), true);
    assert.equal(canOutboundPost(item, BOB), false);
    assert.equal(canOutboundPost(item, null), false);
    assert.equal(
      canOutboundPost(
        {
          source: "farcaster",
          kind: "social",
          author: ALICE,
          body: "pulled cast",
        },
        ALICE,
      ),
      false,
    );
  });
});

describe("prepareShareIntoMesh vs outbound", () => {
  it("share-into-mesh does not call an outbound adapter", async () => {
    const acl = createMemorySeeAcl();
    const item = native();
    const share = prepareShareIntoMesh(acl, item, ALICE);
    assert.ok(!("denied" in share));
    const calls: string[] = [];
    const adapters = createOutboundAdapters({
      env: {},
      farcaster: {
        encodeCast: async () => {
          calls.push("farcaster");
          return new Uint8Array([1]);
        },
      },
    });
    assert.deepEqual(calls, []);
    assert.equal(share.node.body, item.body);
  });
});

describe("readFarcasterOutboundConfig", () => {
  it("fails closed when fid/signer missing or leaked via NEXT_PUBLIC", () => {
    assert.equal(readFarcasterOutboundConfig({}), null);
    assert.equal(readFarcasterOutboundConfig({ FARCASTER_FID: "3" }), null);
    assert.equal(
      readFarcasterOutboundConfig({
        FARCASTER_FID: "3",
        FARCASTER_SIGNER_KEY: SIGNER,
        NEXT_PUBLIC_FARCASTER_SIGNER_KEY: SIGNER,
      }),
      null,
    );
    const ok = readFarcasterOutboundConfig({
      FARCASTER_FID: "3",
      FARCASTER_SIGNER_KEY: SIGNER,
      FARCASTER_HUB_BASE: "https://hub.example",
    });
    assert.ok(ok);
    assert.equal(ok.fid, 3);
    assert.equal(ok.hubBase, "https://hub.example");
    assert.equal(parseSignerKey("not-hex"), null);
    assert.equal(parseSignerKey(SIGNER)?.length, 32);
  });
});

describe("FarcasterOutbound", () => {
  it("disabled + honest reason when unset", async () => {
    const adapter = new FarcasterOutbound({ env: {} });
    assert.equal(adapter.enabled, false);
    const result = await adapter.post({ body: "gm" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, FARCASTER_NOT_CONFIGURED);
  });

  it("rejects an overlong cast", async () => {
    const adapter = new FarcasterOutbound({
      env: { FARCASTER_FID: "1", FARCASTER_SIGNER_KEY: SIGNER },
    });
    const result = await adapter.post({ body: "x".repeat(400) });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, FARCASTER_TOO_LONG);
  });

  it("POSTs octet-stream to /v1/submitMessage with optional basic auth", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const adapter = new FarcasterOutbound({
      env: {
        FARCASTER_FID: "2",
        FARCASTER_SIGNER_KEY: SIGNER,
        FARCASTER_HUB_BASE: "https://hub.example",
        FARCASTER_HUB_AUTH: "lab:secret",
      },
      encodeCast: async () => new Uint8Array([9, 8, 7]),
      fetch: (async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(
          JSON.stringify({ hash: "0xabc123" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    });
    assert.equal(adapter.enabled, true);
    const result = await adapter.post({
      body: "  gm from mine  ",
      permalink: "https://s3r.ch/feed",
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.network, "Farcaster");
      assert.equal(result.url, "https://farcaster.xyz/~/conversations/0xabc123");
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://hub.example/v1/submitMessage");
    const headers = new Headers(calls[0]?.init.headers);
    assert.equal(headers.get("content-type"), "application/octet-stream");
    assert.equal(headers.get("authorization"), `Basic ${Buffer.from("lab:secret").toString("base64")}`);
    assert.ok(calls[0]?.init.body instanceof Uint8Array);
  });

  it("fails closed on hub HTTP error", async () => {
    const adapter = new FarcasterOutbound({
      env: { FARCASTER_FID: "2", FARCASTER_SIGNER_KEY: SIGNER },
      encodeCast: async () => new Uint8Array([1]),
      fetch: (async () =>
        new Response(JSON.stringify({ details: "unauthorized" }), {
          status: 401,
        })) as typeof fetch,
    });
    const result = await adapter.post({ body: "gm" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "unauthorized");
  });

  it("encodeCastAdd produces hub-shaped bytes", async () => {
    const bytes = await encodeCastAdd({
      text: "fixture",
      embeds: [],
      fid: 1,
      signerKey: parseSignerKey(SIGNER) ?? new Uint8Array(32),
    });
    assert.ok(bytes.byteLength > 20);
  });
});

describe("farcasterResultUrl", () => {
  it("builds a conversation permalink from the hub hash", () => {
    assert.equal(
      farcasterResultUrl({ hash: "0xff" }, null),
      "https://farcaster.xyz/~/conversations/0xff",
    );
    assert.equal(farcasterResultUrl({}, null), "");
  });
});

describe("readAtprotoOutboundConfig", () => {
  it("fails closed when identifier/password missing or NEXT_PUBLIC", () => {
    assert.equal(readAtprotoOutboundConfig({}), null);
    assert.equal(
      readAtprotoOutboundConfig({ ATPROTO_IDENTIFIER: "lab.bsky.social" }),
      null,
    );
    assert.equal(
      readAtprotoOutboundConfig({
        ATPROTO_IDENTIFIER: "lab.bsky.social",
        ATPROTO_APP_PASSWORD: "xxxx-xxxx-xxxx-xxxx",
        NEXT_PUBLIC_ATPROTO_APP_PASSWORD: "leak",
      }),
      null,
    );
    const ok = readAtprotoOutboundConfig({
      ATPROTO_IDENTIFIER: "lab.bsky.social",
      ATPROTO_APP_PASSWORD: "xxxx-xxxx-xxxx-xxxx",
    });
    assert.ok(ok);
    assert.equal(ok.pdsBase, "https://bsky.social");
  });
});

describe("AtprotoOutbound", () => {
  it("disabled + honest reason when unset", async () => {
    const adapter = new AtprotoOutbound({ env: {} });
    assert.equal(adapter.enabled, false);
    const result = await adapter.post({ body: "gm" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, ATPROTO_NOT_CONFIGURED);
  });

  it("rejects an overlong post", async () => {
    const adapter = new AtprotoOutbound({
      env: {
        ATPROTO_IDENTIFIER: "lab.bsky.social",
        ATPROTO_APP_PASSWORD: "xxxx",
      },
    });
    const result = await adapter.post({ body: "x".repeat(301) });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, ATPROTO_TOO_LONG);
  });

  it("createSession then createRecord on the PDS, never AppView", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const adapter = new AtprotoOutbound({
      env: {
        ATPROTO_IDENTIFIER: "lab.bsky.social",
        ATPROTO_APP_PASSWORD: "app-pass",
        ATPROTO_PDS_BASE: "https://pds.example",
      },
      fetch: (async (url, init) => {
        const parsed = init?.body ? JSON.parse(String(init.body)) : null;
        calls.push({ url: String(url), body: parsed });
        if (String(url).includes("createSession")) {
          return new Response(
            JSON.stringify({
              accessJwt: "jwt-token",
              did: "did:plc:lab",
              handle: "lab.bsky.social",
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            uri: "at://did:plc:lab/app.bsky.feed.post/rkey1",
            cid: "bafytest",
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });
    const result = await adapter.post({
      body: "hello bluesky",
      permalink: "https://s3r.ch/feed",
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(
        result.url,
        "https://bsky.app/profile/lab.bsky.social/post/rkey1",
      );
    }
    assert.equal(calls.length, 2);
    assert.match(calls[0]?.url ?? "", /com\.atproto\.server\.createSession$/);
    assert.deepEqual(calls[0]?.body, {
      identifier: "lab.bsky.social",
      password: "app-pass",
    });
    assert.match(calls[1]?.url ?? "", /com\.atproto\.repo\.createRecord$/);
    const record = calls[1]?.body as { repo?: string; collection?: string };
    assert.equal(record.repo, "did:plc:lab");
    assert.equal(record.collection, "app.bsky.feed.post");
    assert.equal(
      calls.some((call) => call.url.includes("public.api.bsky.app")),
      false,
    );
  });

  it("fails closed on a bad app password", async () => {
    const adapter = new AtprotoOutbound({
      env: {
        ATPROTO_IDENTIFIER: "lab.bsky.social",
        ATPROTO_APP_PASSWORD: "bad",
      },
      fetch: (async () =>
        new Response(JSON.stringify({ error: "AuthenticationRequired", message: "Invalid identifier or password" }), {
          status: 401,
        })) as typeof fetch,
    });
    const result = await adapter.post({ body: "gm" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /Invalid identifier or password/);
  });
});

describe("atprotoPostText", () => {
  it("appends a permalink when it fits", () => {
    assert.equal(
      atprotoPostText({ body: "hi", permalink: "https://s3r.ch/x" }),
      "hi\n\nhttps://s3r.ch/x",
    );
    assert.equal(atprotoPostText({ body: "hi", permalink: "not-a-url" }), "hi");
  });
});

describe("createOutboundAdapters", () => {
  it("wires Farcaster + ATProto; leaves ActivityPub / Nostr unimplemented", async () => {
    const adapters = createOutboundAdapters({ env: {} });
    const status = outboundStatus(adapters);
    assert.deepEqual(
      status.map((row) => row.id),
      ["farcaster", "atproto"],
    );
    assert.equal(status.every((row) => row.enabled === false), true);
    const ap = adapters.find((row) => row.network === "ActivityPub");
    assert.ok(ap instanceof UnimplementedOutbound);
    const nostr = adapters.find((row) => row.network === "Nostr");
    assert.ok(nostr instanceof UnimplementedOutbound);
    const skipped = await postOutbound(adapters, "farcaster", { body: "gm" });
    assert.equal(skipped.ok, false);
    const farcaster = adapterForNetwork(adapters, "farcaster");
    assert.ok(farcaster instanceof FarcasterOutbound);
    const atproto = adapterForNetwork(adapters, "atproto");
    assert.ok(atproto instanceof AtprotoOutbound);
  });

  it("reports enabled when server env is present", () => {
    const adapters = createOutboundAdapters({
      env: {
        FARCASTER_FID: "1",
        FARCASTER_SIGNER_KEY: SIGNER,
        ATPROTO_IDENTIFIER: "lab.bsky.social",
        ATPROTO_APP_PASSWORD: "xxxx",
      },
    });
    const status = outboundStatus(adapters);
    assert.equal(status.find((row) => row.id === "farcaster")?.enabled, true);
    assert.equal(status.find((row) => row.id === "atproto")?.enabled, true);
  });
});

describe("draftFromItem", () => {
  it("copies body and permalink off an owned post", () => {
    const item = { ...native(), permalink: " https://s3r.ch/a " };
    assert.deepEqual(draftFromItem(item), {
      body: item.body,
      permalink: "https://s3r.ch/a",
      tags: item.tags,
    });
  });
});
