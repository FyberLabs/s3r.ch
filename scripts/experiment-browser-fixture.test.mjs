import test from "node:test";
import assert from "node:assert/strict";
import { scheduledExperiments, validateExperimentBrowserFixture } from "./experiment-browser-fixture.mjs";
import { validateStartupBrowserFixture } from "./startup-browser-fixture.mjs";
test("flags browser uses the declared startup projection and scheduled-only owner context",()=>{
  assert.equal(validateExperimentBrowserFixture,validateStartupBrowserFixture);
  const env={GITHUB_ACTIONS:"true",GITHUB_EVENT_NAME:"schedule",GITHUB_WORKFLOW_REF:"FyberLabs/infra/.github/workflows/nightly-integration.yml@refs/heads/main",GITHUB_REPOSITORY:"FyberLabs/s3r.ch",GITHUB_REF:"refs/heads/master",NIGHTLY_SUITE:"flags-s3rch-browser"};
  assert.equal(scheduledExperiments(env),true);
  for(const key of Object.keys(env))assert.equal(scheduledExperiments({...env,[key]:"wrong"}),false);
  assert.equal(scheduledExperiments({...env,GITHUB_EVENT_NAME:"workflow_dispatch"}),false);
});
