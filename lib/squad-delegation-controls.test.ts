import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SquadDelegationControls } from "../components/SquadDelegationControls";

test("task controls render disabled and explain the missing revocation confirmation", () => {
  const html = renderToStaticMarkup(createElement(SquadDelegationControls));
  assert.match(html, /<fieldset[^>]*disabled=""[^>]*aria-describedby="squad-delegation-unavailable"/);
  for (const name of ["squad-reassign", "squad-reassign-target"]) {
    const tag = html.match(new RegExp(`<[^>]*data-testid="${name}"[^>]*>`))?.[0];
    assert.ok(tag, name);
    assert.match(tag, /disabled=""/, name);
  }
  assert.match(html, /id="squad-delegation-unavailable"/);
  assert.match(html, /Reassignment is unavailable until access changes can be verified/);
  assert.doesNotMatch(html, /squad-pause|>Pause<|>Stop<|worker/i);
  assert.match(html, /status alone does not change permissions/);
});
