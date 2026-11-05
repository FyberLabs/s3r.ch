import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { fetchPublic } from "./public-fetch";
import { assertPublicHttpUrl, isBlockedIpAddress } from "./url-guard";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("assertPublicHttpUrl", () => {
  it("accepts public http(s) hosts and addresses", () => {
    assert.equal(
      assertPublicHttpUrl("https://blog.ethereum.org/en/feed.xml").href,
      "https://blog.ethereum.org/en/feed.xml",
    );
    assert.equal(assertPublicHttpUrl("http://8.8.8.8/feed").hostname, "8.8.8.8");
    assert.equal(assertPublicHttpUrl("http://[2606:4700::1]/feed").hostname, "[2606:4700::1]");
    assert.equal(assertPublicHttpUrl("http://172.32.0.1/").hostname, "172.32.0.1");
    assert.equal(assertPublicHttpUrl("http://1.1.1.1/").hostname, "1.1.1.1");
  });

  it("rejects non-http schemes, metadata names, and non-public addresses", () => {
    const rejected = [
      "file:///etc/passwd",
      "ftp://example.com/feed",
      "javascript:alert(1)",
      "http://localhost/x",
      "http://localhost./x",
      "http://foo.localhost/x",
      "http://foo.local/x",
      "http://foo.internal/x",
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://metadata.azure.com/",
      "http://127.0.0.1/",
      "http://127.1/",
      "http://2130706433/",
      "http://0x7f.0.0.1/",
      "http://10.1.2.3/",
      "http://192.168.1.1/",
      "http://172.16.0.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://100.64.0.1/",
      "http://0.0.0.0/",
      "http://224.0.0.1/",
      "http://[::1]/",
      "http://[::]/",
      "http://[fd00::1]/",
      "http://[fe80::1]/",
      "http://[ff02::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:169.254.169.254]/",
      "http://[::ffff:10.0.0.1]/",
      "http://[2002:7f00:1::]/",
      "http://[64:ff9b::7f00:1]/",
      "http://[64:ff9b:1::1]/",
      "not a url",
    ];
    for (const raw of rejected) {
      assert.throws(() => assertPublicHttpUrl(raw), Error, raw);
    }
  });
});

describe("isBlockedIpAddress", () => {
  it("blocks DNS answers in private and metadata ranges", () => {
    assert.equal(isBlockedIpAddress("8.8.8.8"), false);
    assert.equal(isBlockedIpAddress("2606:4700::1"), false);
    assert.equal(isBlockedIpAddress("127.0.0.1"), true);
    assert.equal(isBlockedIpAddress("169.254.169.254"), true);
    assert.equal(isBlockedIpAddress("::1"), true);
    assert.equal(isBlockedIpAddress("fd00::1"), true);
    assert.equal(isBlockedIpAddress("::ffff:10.0.0.1"), true);
  });
});

describe("fetchPublic", () => {
  it("does not send a request for a blocked URL", async () => {
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      return Promise.resolve(new Response("no"));
    }) as typeof fetch;
    await assert.rejects(() => fetchPublic("http://169.254.169.254/latest"), /not allowed/);
    await assert.rejects(() => fetchPublic("file:///etc/passwd"), /http\(s\)/);
    assert.equal(calls, 0);
  });

  it("follows a redirect only when the next hop is public", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(init?.redirect, "manual");
      const href = input instanceof URL ? input.href : String(input);
      calls.push(href);
      if (calls.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "/next" },
        });
      }
      return new Response("body", { status: 200 });
    }) as typeof fetch;

    const response = await fetchPublic("https://8.8.8.8/start");
    assert.equal(await response.text(), "body");
    assert.deepEqual(calls, ["https://8.8.8.8/start", "https://8.8.8.8/next"]);
  });

  it("refuses a redirect onto a metadata address", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(input instanceof URL ? input.href : String(input));
      return new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      });
    }) as typeof fetch;
    await assert.rejects(() => fetchPublic("https://1.1.1.1/feed"), /not allowed/);
    assert.deepEqual(calls, ["https://1.1.1.1/feed"]);
  });

  it("stops after too many redirects", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(null, {
        status: 302,
        headers: { location: "https://1.1.1.1/again" },
      });
    }) as typeof fetch;
    await assert.rejects(() => fetchPublic("https://8.8.8.8/loop"), /Too many redirects/);
    assert.equal(calls, 21);
  });

  it("fetches a public hostname after DNS answers are public", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(input instanceof URL ? input.href : String(input));
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    const response = await fetchPublic("https://example.com/feed.xml");
    assert.equal(response.status, 200);
    assert.deepEqual(calls, ["https://example.com/feed.xml"]);
  });
});
