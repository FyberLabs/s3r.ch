import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LookupAddress, LookupOptions } from "node:dns";
import { Agent } from "undici";
import { createPublicLookup } from "./public-fetch-server";

function resolveThroughSocket(signal: AbortSignal, resolver: (host: string) => Promise<LookupAddress[]>, options: LookupOptions = {}) {
  const lookup = createPublicLookup(signal, resolver);
  return new Promise<string | LookupAddress[]>((resolve, reject) => {
    lookup("feeds.example", options, (error, address) => error ? reject(error) : resolve(address));
  });
}

describe("public connection DNS lookup", () => {
  it("hands the validated answer to the socket instead of resolving again", async () => {
    let resolutions = 0;
    const address = await resolveThroughSocket(new AbortController().signal, async (host) => {
      assert.equal(host, "feeds.example");
      resolutions += 1;
      return [{ address: resolutions === 1 ? "8.8.8.8" : "127.0.0.1", family: 4 }];
    });
    assert.equal(address, "8.8.8.8");
    assert.equal(resolutions, 1);
  });

  it("rejects mixed public/private answers before selecting a family", async () => {
    for (const address of ["127.0.0.1", "169.254.169.254", "::1", "::ffff:10.0.0.1"]) {
      await assert.rejects(resolveThroughSocket(new AbortController().signal, async () => [
        { address: "8.8.8.8", family: 4 }, { address, family: address.includes(":") ? 6 : 4 },
      ], { all: true, family: 4 }), /not allowed/);
    }
  });

  it("validates every raw DNS address and its family before selecting any answer", async () => {
    for (const row of [
      { address: "198.18.0.1", family: 4 }, { address: "3fff::1", family: 6 },
      { address: "8.8.8.8", family: 6 }, { address: "2606:4700::1", family: 4 },
      { address: "8.8.8.8 ", family: 4 }, { address: "008.8.8.8", family: 4 },
      { address: "[2606:4700::1]", family: 6 }, { address: "2606:4700::1%eth0", family: 6 },
    ]) {
      await assert.rejects(resolveThroughSocket(new AbortController().signal, async () => [
        { address: "192.0.0.9", family: 4 }, row,
      ], { family: 4 }), /not allowed/, row.address);
    }
  });

  it("preserves validated IPv4 and IPv6 answers for socket family selection", async () => {
    const records = [{ address: "8.8.8.8", family: 4 }, { address: "2606:4700::1", family: 6 }];
    assert.deepEqual(await resolveThroughSocket(new AbortController().signal, async () => records, { all: true }), records);
    assert.equal(await resolveThroughSocket(new AbortController().signal, async () => records, { family: 6 }), "2606:4700::1");
  });

  it("does not fall back to unchecked DNS after resolver failure or empty answers", async () => {
    await assert.rejects(resolveThroughSocket(new AbortController().signal, async () => { throw new Error("DNS failed"); }), /DNS failed/);
    await assert.rejects(resolveThroughSocket(new AbortController().signal, async () => []), /not allowed/);
    await assert.rejects(resolveThroughSocket(new AbortController().signal, async () => [{ address: "not-an-IP", family: 4 }]), /not allowed/);
  });

  it("Node fetch reaches the guarded socket lookup with the installed dispatcher", async () => {
    let resolutions = 0;
    const dispatcher = new Agent({ connect: { lookup: createPublicLookup(new AbortController().signal, async () => {
      resolutions += 1;
      throw new Error("Guarded lookup reached without opening a socket");
    }) } });
    try {
      await assert.rejects(fetch("https://guarded.example/", { dispatcher } as RequestInit & { dispatcher: Agent }), (error: unknown) => {
        assert.equal((error as Error & { cause?: Error }).cause?.message, "Guarded lookup reached without opening a socket");
        return true;
      });
      assert.equal(resolutions, 1);
    } finally {
      await dispatcher.close();
    }
  });

  it("a shared deadline aborts a stalled lookup and ignores a late answer", async () => {
    const controller = new AbortController();
    let finish!: (records: LookupAddress[]) => void;
    let callbacks = 0;
    const completed = new Promise<void>((resolve) => {
      createPublicLookup(controller.signal, () => new Promise((r) => { finish = r; }))(
        "feeds.example", {}, (error) => {
          callbacks += 1;
          assert.equal(error?.name, "TimeoutError");
          resolve();
        },
      );
    });
    await Promise.resolve();
    controller.abort(new DOMException("Request timed out", "TimeoutError"));
    await completed;
    finish([{ address: "8.8.8.8", family: 4 }]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(callbacks, 1);
    let resolutions = 0;
    await assert.rejects(resolveThroughSocket(controller.signal, async () => {
      resolutions += 1;
      return [{ address: "8.8.8.8", family: 4 }];
    }), { name: "TimeoutError" });
    assert.equal(resolutions, 0);
  });
});
