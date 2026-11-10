import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ForumHierarchyPreview } from "../components/ForumHierarchyPreview";
import { PILOT_NEEDS } from "./forum-squad-fixture";

test("parent boards only show the current open revision escalated to that level", () => {
  for (const need of PILOT_NEEDS) {
    const props = { squadLabel: "Squad", members: 1, needingHelp: 0, emergencies: 0, alarm: false,
      onSelect() {}, onToggleCommand() {}, needs: new Map([[need.id, need]]) };
    for (const level of ["Command", "Fleet"] as const) {
      const render = (command: boolean, revision: number, stated: 0 | 1 = 1) => renderToStaticMarkup(
        createElement(ForumHierarchyPreview, { ...props, level, needs: new Map([[need.id, { ...need, stated }]]),
          escalations: new Map([[need.id, { revision, command }]]) }));
      assert.equal(render(false, need.hamState).includes("No open escalations."), level === "Command");
      assert.equal(render(true, need.hamState).includes("No open escalations."), level === "Command" && need.severity !== "emergency");
      assert.match(render(true, need.hamState - 1), /No open escalations/);
      assert.match(render(true, need.hamState, 0), /No open escalations/);
    }
  }
});
