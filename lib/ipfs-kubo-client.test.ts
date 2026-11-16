import {test} from "node:test";
import assert from "node:assert/strict";
import {createKuboBlockClient} from "./ipfs-kubo-client";
import {rawMediaBlockCid} from "./ipfs-media-blocks";
const bytes = new Uint8Array([1, 2, 3]);
const options = () => ({endpoint: "https://provider.example", current: () => true, signal: new AbortController().signal, maxBytes: 100});
test("direct fixed Kubo operations verify CID and omit browser credentials", async () => {
  const cid = await rawMediaBlockCid(bytes); let calls = 0;
  const client = createKuboBlockClient(options(), async (url, init) => {
    calls++; assert.equal(init?.credentials, "omit"); assert.equal(init?.redirect, "error");
    assert.equal(init?.method, "POST"); assert.equal(init?.referrerPolicy, "no-referrer");
    const target = new URL(String(url)); assert.equal(target.origin, "https://provider.example");
    if (target.pathname.endsWith("put")) {
      assert.equal(target.searchParams.get("pin"), "false");
      assert.equal(target.searchParams.get("cid-codec"), "raw");
      const file = (init!.body as FormData).get("file") as File;
      assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes);
      return Response.json({Key: cid, Size: bytes.length});
    }
    assert.equal(target.searchParams.get("arg"), cid); return new Response(bytes);
  });
  assert.equal(await client.put(bytes), cid); assert.deepEqual(await client.get(cid, 3), bytes); assert.equal(calls, 2);
});
test("refuses endpoint ambiguity and invalid budgets", () => {
  for (const endpoint of ["http://provider.example", "https://user:pass@provider.example", "https://provider.example/api", "https://provider.example/?token=secret", "https://provider.example/#x"])
    assert.throws(() => createKuboBlockClient({...options(), endpoint}));
  assert.throws(() => createKuboBlockClient({...options(), maxBytes: Infinity}));
});
test("failed attempts consume budget and never retry", async () => {
  let calls = 0;
  const client = createKuboBlockClient({...options(), maxBytes: 3}, async () => { calls++; return new Response("bad", {status: 500}); });
  await assert.rejects(client.put(bytes)); await assert.rejects(client.put(bytes)); assert.equal(calls, 1);
});
test("rejects corrupt, excessive and wrong-size bodies and false upload receipt", async () => {
  const cid = await rawMediaBlockCid(bytes);
  for (const body of [new Uint8Array([3, 2, 1]), new Uint8Array(4), new Uint8Array(2)]) {
    const client = createKuboBlockClient(options(), async () => new Response(body));
    await assert.rejects(client.get(cid, 3));
  }
  await assert.rejects(createKuboBlockClient(options(), async () => Response.json({Key: cid, Size: 4})).put(bytes));
});
test("revocation and cancellation fail before dispatch and after response", async () => {
  let calls = 0, allowed = false;
  const controller = new AbortController();
  const client = createKuboBlockClient({...options(), current: () => allowed, signal: controller.signal}, async () => { calls++; allowed = false; return new Response(bytes); });
  await assert.rejects(client.put(bytes)); assert.equal(calls, 0);
  allowed = true; await assert.rejects(client.get(await rawMediaBlockCid(bytes), 3)); assert.equal(calls, 1);
  allowed = true; controller.abort(); await assert.rejects(client.put(bytes)); assert.equal(calls, 1);
});
test("at most two pending operations including abort-ignoring transport", async () => {
  const controller = new AbortController(); let calls = 0;
  const client = createKuboBlockClient({...options(), signal: controller.signal}, async () => {calls++; return new Promise<Response>(() => {});});
  const cid = await rawMediaBlockCid(bytes);
  const first = client.get(cid, 3), second = client.get(cid, 3);
  await assert.rejects(client.get(cid, 3)); assert.equal(calls, 2);
  controller.abort(); await assert.rejects(first); await assert.rejects(second);
});
