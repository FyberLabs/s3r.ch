import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { p256 } from "@noble/curves/nist.js";
import { forumBotFixture } from "./forum-bot-test-fixture";
import { forumReportStatementAdmissionBody, openArtifactSignatures, parseVisorForumReport, parseVisorReporterRequest } from "./forum-visor-reporter";
import type { VerifiedForumUpdate } from "./forum-plane-update";
import { parseSignedBriefDraft, verifyBriefDraft } from "./squad-brief";
import { parseSignedWorkbook, verifyWorkbookDraft } from "./squad-workbook";
import { parseSignedPreview, verifyPreviewDraft } from "./squad-preview";

test("status-only forum reports omit the retired plane update envelope", () => {
  const rows = [{ kind: "object" }];
  const envelope = { rows, update: { botId: "test", signature: "sig" } };
  const body = forumReportStatementAdmissionBody(100, "forum_test", "owner.test", envelope, null);
  assert.deepEqual(Object.keys(body).sort(), ["evaluatedAt", "forumId", "owner", "rows", "version"]);
  const withArtifact = forumReportStatementAdmissionBody(100, "forum_test", "owner.test", envelope,
    { kind: "brief", draft: { taskId: "00000000-0000-4000-8000-000000000001", artifactId: "00000000-0000-4000-8000-000000000002", revisionId: "00000000-0000-4000-8000-000000000003", base: null, markdown: "x" } },
    { brief: { signature: "s" } });
  assert.ok("update" in withArtifact);
});

test("Visor reporter only accepts a scoped terminal status projection", async t => {
  const f = await forumBotFixture(t);
  const report = { tenant: f.tenant, botId: f.botA, assignmentId: randomUUID(), sessionId: randomUUID(),
    taskId: randomUUID(), deliveryId: randomUUID(), forumId: f.forum, principal: f.a.pub, status: "completed" };
  assert.deepEqual(parseVisorForumReport(report), report);
  assert.deepEqual(parseVisorReporterRequest(report), { report, artifact: null });
  assert.equal(parseVisorForumReport({ ...report, prompt: "private" }), null);
  assert.equal(parseVisorForumReport({ ...report, status: "delivered" }), null);
  assert.equal(parseVisorForumReport({ ...report, deliveryId: "../other" }), null);
});

test("the reporter signs each artifact under the same delivery and recovers its exact intent", async t => {
  const f = await forumBotFixture(t);
  const report = { tenant: f.tenant, botId: f.botA, assignmentId: randomUUID(), sessionId: randomUUID(),
    taskId: randomUUID(), deliveryId: randomUUID(), forumId: f.forum, principal: f.a.pub, status: "completed" as const };
  const update: VerifiedForumUpdate = { ...report, statementId: "fixture-statement",
    sequence: 1, signature: "fixture-status", attestation: "fixture-attestation" };
  const taskId = randomUUID();
  const brief = { kind: "brief", draft: { taskId, artifactId: randomUUID(), revisionId: randomUUID(), base: null,
    markdown: "# Partner pilot\nTen seats for 30 days." } };
  const workbook = { kind: "workbook", draft: { taskId, artifactId: randomUUID(), revisionId: randomUUID(),
    inputs: { quantity: 10, unitPriceCents: 12000, discountBps: 0 } } };
  const preview = { kind: "preview", draft: { taskId, artifactId: randomUUID(), revisionId: randomUUID(), base: null,
    briefRevisionId: brief.draft.revisionId, workbookRevisionId: workbook.draft.revisionId,
    copy: { title: "Partner pilot", summary: "Ten seats.", highlights: [], nextStep: "Confirm the quote." } } };
  const request = (artifact: object) => parseVisorReporterRequest({ version: 1, report, artifact })?.artifact;
  const unsigned = [request(brief), request(workbook), request(preview)];
  assert.equal(parseVisorReporterRequest({ version: 2, report, artifact: brief }), null);
  assert.equal(parseVisorReporterRequest({ version: 1, report: { ...report, status: "failed" }, artifact: brief }), null);
  assert.equal(request({ ...brief, draft: { ...brief.draft, signature: "caller-signed" } }), undefined);

  const dir = mkdtempSync(join(tmpdir(), "visor-artifact-intent-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "reporter.sqlite");
  const sign = (bytes: Uint8Array) => Buffer.from(p256.sign(bytes, Buffer.from(f.a.priv, "base64url"),
    { prehash: true, format: "compact" })).toString("base64url");
  let signed: unknown[];
  const first = new DatabaseSync(path);
  try {
    const save = openArtifactSignatures(first, sign);
    signed = unsigned.map(artifact => {
      assert.ok(artifact);
      return save(artifact, update);
    });
  } finally {
    first.close();
  }
  const [savedBrief, savedWorkbook, savedPreview] = [
    parseSignedBriefDraft(signed[0]), parseSignedWorkbook(signed[1]), parseSignedPreview(signed[2]),
  ];
  assert.ok(savedBrief && savedWorkbook && savedPreview);
  assert.ok(verifyBriefDraft(savedBrief, update, f.a.pub));
  assert.ok(verifyWorkbookDraft(savedWorkbook, update, f.a.pub));
  assert.ok(verifyPreviewDraft(savedPreview, update, f.a.pub));
  assert.equal(verifyBriefDraft(savedBrief, update, f.b.pub), false);
  assert.equal(verifyPreviewDraft(savedPreview, { ...update, forumId: "other-forum" }, f.a.pub), false);
  assert.equal(verifyPreviewDraft(savedPreview, { ...update, assignmentId: randomUUID() }, f.a.pub), false);

  const reopened = new DatabaseSync(path);
  try {
    const recover = openArtifactSignatures(reopened, () => { throw Error("Retry signed again"); });
    const original = request(preview);
    const changed = request({ ...preview, draft: { ...preview.draft, workbookRevisionId: randomUUID() } });
    assert.ok(original && changed);
    assert.deepEqual(recover(original, update), savedPreview);
    assert.throws(() => recover(changed, update), /delivery changed/);
    assert.throws(() => recover(original, { ...update, status: "failed" }), /did not complete/);
  } finally {
    reopened.close();
  }
});
