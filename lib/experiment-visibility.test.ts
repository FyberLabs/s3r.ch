import test from "node:test";
import assert from "node:assert/strict";
import { experimentHeadingVisible } from "./experiment-visibility";
test("initial partial intersection does not count as a half-visible exposure", () => {
  for (const ratio of [0, 0.01, 0.49]) assert.equal(experimentHeadingVisible([{isIntersecting:true,intersectionRatio:ratio}]),false);
  assert.equal(experimentHeadingVisible([{isIntersecting:false,intersectionRatio:1}]),false);
  for (const ratio of [0.5, 1]) assert.equal(experimentHeadingVisible([{isIntersecting:true,intersectionRatio:ratio}]),true);
});
