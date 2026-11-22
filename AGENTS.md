<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Mandatory agent worktrees

The owner explicitly authorizes agents to create task worktrees and local
task branches without asking. Before editing, create or reuse a dedicated
worktree for your task. Create new worktrees from the freshly fetched remote
default branch. Use the Codex worktree tool when available.

The primary checkout is for read-only inspection and fetching. Do all edits,
builds, tests and commits in the task worktree. Keep other agents' worktrees
and existing local changes intact. If worktree setup fails, resolve it or
report the blocker before editing.

## Git preflight

At the start of work in each repository, run `git status --short --branch`
and fetch the remote default branch before relying on local files. For an
`origin` remote with a `main` default branch, run `git fetch origin main`.
Use the actual remote and default branch when they differ. Check whether
your branch has diverged from the fetched default branch and inspect upstream
changes relevant to the task. If the fetch fails, report the limitation before
relying on stale local configuration.

Base new task branches on the freshly fetched default branch. For existing
work, preserve local edits and commits. Read current files from the fetched
ref when needed.

## Shared TEST and production configuration

Start with `FyberLabs/infra` on its current default branch. Read its
`AGENTS.md` configuration rules and `docs/CONFIG.md`, then look in
`config/manifest.yaml`, `config/environments/` and the relevant fixture
declarations. Recover and reuse existing deployment facts, credential
references and fixtures. Put new shared declarations and repeatable
provisioning in Infra, and keep component-owned fixtures with their owner.
Use the canonical secret store for credential values. Ask the owner only
for the exact external action or authority you lack.

## Production implementation and release readiness

When the owner requests production work, complete the production code,
configuration, deployment wiring, and CI coverage in scope. Follow shared
configuration into Infra and component changes into the owning repository
when the request includes those repositories. Keep working through independent
items if one dependency is blocked. A green TEST run does not complete
production deliverables.

Before requesting release approval, prepare the PRs and candidate artifacts,
run the applicable authorized CI, fix failures in scope, and verify the
results. Run PR checks and release qualification in their designated CI
workflows. Use existing controlled fixtures and automated checks. Put checks
that require a live rollout in the authorized deployment workflow.

Bring the owner the exact candidate version and source revision, the CI
results, and the specific action and target that need authorization. Identify
any concrete blocker and complete the remaining authorized preparation.
Explicit approval for the specific version and action is required before an
actual manual tag, release, or production promotion, including a merge or
workflow dispatch that performs the gated action. Existing automatic TEST
publication retains its standing authorization. Follow existing authority for
live production applies and provider actions.

## Service deployments and binary provenance

Running services follow a version tag and pick up patches on that line. They are patch-compatible within a minor version. Deploy the minor line, for example `ghcr.io/fyberlabs/s3r.ch:1.4`, or a moving channel tag such as `ghcr.io/fyberlabs/s3r.ch:test` for TEST. Do not deploy a running service by image digest, commit SHA, or a frozen patch tag. Do not require a peer service to run one identical build. A running service may report its revision for diagnostics.

Each code change gets a new patch version. A downloadable package is referenced by that version, not by a hash.

A digest may be recorded to verify which image a tag resolved to. It is not the reference used to deploy.

TEST follows `ghcr.io/fyberlabs/s3r.ch:test`, which advances when a build from the default branch is published. A new minor line for production is an explicit release choice. Patches inside the current minor line arrive through the minor tag.
