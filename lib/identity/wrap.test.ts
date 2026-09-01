import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { notImplemented, unwrapDek, wrapDek } from "./wrap";

describe("PRF wrap stub", () => {
  it("notImplemented throws", () => {
    assert.throws(() => notImplemented(), /not implemented/);
  });

  it("wrap and unwrap stay stubs", () => {
    assert.throws(
      () => wrapDek({ dek: new Uint8Array(32), prfKek: new Uint8Array(32), secondaryKek: new Uint8Array(32) }),
      /PRF wrap/,
    );
    assert.throws(
      () => unwrapDek({
        version: 1,
        rpId: "s3r.ch",
        dekWrappedByPrfKek: "",
        dekWrappedBySecondaryKek: "",
      }),
      /not implemented/,
    );
  });
});
