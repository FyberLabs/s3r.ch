import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { readForumSignature, signForumRecord, signatureOf } from "@/lib/forum-sign";
import type { SeaPair } from "@/lib/identity/sea";

describe("forum record signatures", () => {
  it("round-trips a signed record and rejects a different pubkey", async () => {
    const sea = createRequire(import.meta.url)("gun/sea") as { pair: () => Promise<SeaPair> };
    const pair = await sea.pair();
    const other = await sea.pair();
    const record = { task: "hold", lastUpdate: 10 };
    const sig = await signForumRecord(record, pair);
    assert.equal(typeof sig, "string");
    assert.equal(signatureOf({ sig }), sig);
    const back = await readForumSignature(sig, pair.pub);
    assert.deepEqual(back, record);
    assert.equal(await readForumSignature(sig, other.pub), null);
    assert.equal(await readForumSignature("not-a-signature", pair.pub), null);
  });
});
