import assert from "node:assert/strict";
import test from "node:test";
import { checkForumChildWrite } from "./forum-child-write";
import type { SeeGraph, CheckResult } from "./check";
import vectors from "./vectors/forum-child.json";

// Decision-only projection: admission/merge outcomes come from the upstream
// fixture. Real signed ingestion is exercised by forum-authority/drawer tests.
for (const c of vectors.cases) test(`upstream child-write decision: ${c.name}`, () => {
  const owners = new Map<string, string>();
  type Grant = { object: string; accessor: string; stated: number; from: number; until: number };
  const see = new Map<string, Grant>(), post = new Map<string, Grant>();
  const check = (rows: Map<string, Grant>, id: string, who: string, now: number): CheckResult => {
    if (!owners.has(id)) return { allowed: false, reason: "missing-object" };
    if (owners.get(id) === who) return { allowed: true, reason: "owner" };
    const row = rows.get(id + who);
    return { allowed: !!row && row.stated === 1 && now >= row.from && now < row.until, reason: "grant" };
  };
  const graph: SeeGraph = { ownerOf: id => owners.get(id), hasObject: id => owners.has(id), seeGrants: () => [],
    checkDirectSee: (id, who, now) => check(see, id, who, now),
    checkPost: (id, who, now) => check(post, id, who, now),
    checkForumSee: () => ({ allowed: true, reason: "same-group" }) };
  type Step = { op: string; record?: { object: string; owner: string }; row?: Grant; kept?: boolean;
    object?: string; accessor?: string; agent?: string; forum?: string; now?: number; allowed?: boolean };
  for (const step of c.steps as Step[]) {
    if (step.op === "put" && step.kept && step.record) owners.set(step.record.object, step.record.owner);
    if ((step.op === "admit" || step.op === "admit-post") && step.kept && step.row)
      (step.op === "admit" ? see : post).set(step.row.object + step.row.accessor, step.row);
    if (step.op === "check-drawer-write")
      assert.equal(checkForumChildWrite(graph, step.forum!, step.agent!, step.object!, step.accessor!, step.now!).allowed, step.allowed);
  }
});
