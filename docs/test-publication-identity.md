# TEST release publication identity

A queued deployment publishes the exact verified merge revision. If master advances
and its workflow files differ, GitHub requires workflow-write authorization to
create the historical tag/release. The built-in GITHUB_TOKEN cannot obtain this
permission. Do not substitute the current branch head for the tested revision.

Before merging this workflow change, configure a dedicated GitHub App installed
only on FyberLabs/s3r.ch, with repository Contents: write and Workflows: write
(and implicit Metadata: read). No organization permissions or webhook are needed.
Store its App ID as TEST environment variable S3RCH_TEST_PUBLICATION_APP_ID and
its private key as TEST environment secret S3RCH_TEST_PUBLICATION_APP_PRIVATE_KEY.
Never commit the private key. App creation/installation and permission grants are
separate operator actions; this change does not perform them.

The deploy workflow uses a separate fresh GitHub-hosted publication job after
deployment verification. It checks out no source and executes no code from the
merged revision. Its publication helper is fetched at a fixed reviewed commit
and SHA-256 verified before the App key is used. It receives only the validated
image digest from deployment and independently verifies registry channels.
The short-lived installation token is passed only to the TEST release step.
The action revokes the token during cleanup. Build, image push, deployment,
attestation and static dispatch retain their existing identities. The infra-only
static dispatch App must not be reused or granted extra permissions.

This does not authorize manual tags, releases, workflow retries, production
publication or changes to the static publication queue. No version bump is needed
for this workflow-only change. Validate with the offline release and workflow
contracts; operational verification belongs to the next automatic deployment.

Reference: https://docs.github.com/en/rest/releases/releases#create-a-release
