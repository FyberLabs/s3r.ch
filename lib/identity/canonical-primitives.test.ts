import assert from "node:assert/strict";
import test from "node:test";
import { uniqueJson } from "./forum-witness-json";
test("canonical witness JSON rejects ambiguity and preserves valid values", () => {
  assert.deepEqual(uniqueJson('{"nested":[true,null,3,"a"]}'), { nested: [true, null, 3, "a"] });
  for (const json of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"nested":{"x":1,"x":2}}',
    '{"n":1e999}', '"\\ud800"', '[1] trailing', '['.repeat(18) + '0' + ']'.repeat(18)]) {
    assert.throws(() => uniqueJson(json), /Invalid witness JSON/);
  }
});
