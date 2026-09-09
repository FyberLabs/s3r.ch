import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import "./faker-v7-compat";
import { Factories, Message, makeCastAdd } from "@farcaster/core";
import { faker } from "@faker-js/faker";
import { FarcasterOutbound, encodeCastAdd } from "./farcaster-outbound";

type FakerV7 = typeof faker & {
  datatype: {
    number: (opts?: number | { min?: number; max?: number }) => number;
    datetime: (opts?: { min?: number; max?: number }) => Date;
  };
  random: { alphaNumeric: (count?: number) => string };
};

const aliased = faker as FakerV7;
const required = createRequire(import.meta.url);

describe("faker v7 aliases for @farcaster/core", () => {
  it("exposes datatype.number and random.alphaNumeric after the patch", () => {
    const n = aliased.datatype.number({ min: 3, max: 3 });
    assert.equal(n, 3);
    const token = aliased.random.alphaNumeric(8);
    assert.equal(token.length, 8);
  });

  it("covers the other v7 APIs factories call at import", () => {
    const bounded = aliased.datatype.number(5);
    assert.ok(bounded >= 0 && bounded <= 5);
    const dt = aliased.datatype.datetime({ min: 1_000, max: 2_000 });
    assert.ok(dt instanceof Date);
    const from = new Date("2020-01-01T00:00:00.000Z");
    const to = new Date("2020-01-02T00:00:00.000Z");
    const mid = aliased.date.between(from, to);
    assert.ok(mid instanceof Date);
    assert.ok(mid.getTime() >= from.getTime());
    assert.ok(mid.getTime() <= to.getTime());
  });

  it("patches the CJS singleton @farcaster/core require() uses", () => {
    const cjs = required("@faker-js/faker") as {
      faker: FakerV7;
    };
    assert.equal(typeof cjs.faker.datatype.number, "function");
    assert.equal(cjs.faker.datatype.number({ min: 4, max: 4 }), 4);
    assert.equal(cjs.faker, faker);
  });

  it("lets @farcaster/core finish evaluating (factories run at import)", () => {
    assert.equal(typeof makeCastAdd, "function");
    assert.equal(typeof Message.encode, "function");
    const fid = Factories.Fid.build();
    assert.equal(typeof fid, "number");
    assert.ok(fid >= 1);
  });

  it("importing farcaster-outbound (Next /api/outbound graph) does not throw", () => {
    assert.equal(typeof encodeCastAdd, "function");
    assert.equal(typeof FarcasterOutbound, "function");
  });

  it("CJS require of @farcaster/core succeeds after the shim", () => {
    const core = required("@farcaster/core") as {
      makeCastAdd: typeof makeCastAdd;
      Factories: typeof Factories;
    };
    assert.equal(typeof core.makeCastAdd, "function");
    assert.equal(typeof core.Factories.Fid.build(), "number");
  });

  it("keeps faker on the same Next external list as @farcaster/core", () => {
    const src = readFileSync(new URL("../next.config.mjs", import.meta.url), "utf8");
    assert.match(src, /serverExternalPackages/);
    assert.match(src, /"@faker-js\/faker"/);
    assert.match(src, /"@farcaster\/core"/);
  });
});
