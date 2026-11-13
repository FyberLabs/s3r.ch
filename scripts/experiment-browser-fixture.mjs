// Reuse the declared startup identity projection; no bearer or storage-state input.
export { loadStartupBrowserFixture as loadExperimentBrowserFixture, validateStartupBrowserFixture as validateExperimentBrowserFixture } from "./startup-browser-fixture.mjs";
export function scheduledExperiments(env) {
  return env.GITHUB_ACTIONS === "true" && env.GITHUB_EVENT_NAME === "schedule" &&
    env.GITHUB_WORKFLOW_REF === "FyberLabs/infra/.github/workflows/nightly-integration.yml@refs/heads/main" &&
    env.GITHUB_REPOSITORY === "FyberLabs/s3r.ch" && env.GITHUB_REF === "refs/heads/master" && env.NIGHTLY_SUITE === "flags-s3rch-browser";
}
