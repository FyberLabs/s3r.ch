import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SquadDelegationControls } from "../components/SquadDelegationControls";

test("task controls render disabled and explain the missing revocation confirmation", () => {
  const html = renderToStaticMarkup(createElement(SquadDelegationControls));
  assert.match(html, /<fieldset[^>]*disabled=""[^>]*aria-describedby="squad-delegation-unavailable"/);
  for (const name of ["squad-pause", "squad-reassign", "squad-reassign-target"]) {
    const tag = html.match(new RegExp(`<[^>]*data-testid="${name}"[^>]*>`))?.[0];
    assert.ok(tag, name);
    assert.match(tag, /disabled=""/, name);
  }
  assert.match(html, /id="squad-delegation-unavailable"/);
  assert.match(html, /Pause and reassignment are unavailable/);
  assert.match(html, /Changing its status would not stop its work/);
});
