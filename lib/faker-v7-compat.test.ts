import assert from "node:assert/strict";
import { describe, it } from "node:test";
import "./faker-v7-compat";
import { Message, makeCastAdd } from "@farcaster/core";
import { faker } from "@faker-js/faker";

type FakerV7 = typeof faker & {
  datatype: { number: (opts?: { min?: number; max?: number }) => number };
  random: { alphaNumeric: (count?: number) => string };
};

const aliased = faker as FakerV7;

describe("faker v7 aliases for @farcaster/core", () => {
  it("exposes datatype.number and random.alphaNumeric after the patch", () => {
    const n = aliased.datatype.number({ min: 3, max: 3 });
    assert.equal(n, 3);
    const token = aliased.random.alphaNumeric(8);
    assert.equal(token.length, 8);
  });

  it("lets @farcaster/core finish evaluating (factories run at import)", () => {
    assert.equal(typeof makeCastAdd, "function");
    assert.equal(typeof Message.encode, "function");
  });
});
