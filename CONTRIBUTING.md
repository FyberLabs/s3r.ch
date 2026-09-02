# Contributing

s3r.ch is a Fyber Labs lab domain — a security-oriented social-attack product, not a social-network costume, and not a live search product. Hypermesh is the live commercial product. Questions about Hypermesh belong at [https://hyperme.sh](https://hyperme.sh), not this issue tracker.

Gun is the client graph. Azure App Service is a seed peer / bootstrap cache, not the product datastore. Auth is SIWE; the session binds to an Ethereum address. Native SociACL applies to Gun data; URL fetches are handoffs, not grants.

## Humans

1. Open an issue with the matching form: [Bug](.github/ISSUE_TEMPLATE/bug.yml), [Feature](.github/ISSUE_TEMPLATE/feature.yml), or [Comment](.github/ISSUE_TEMPLATE/comment.yml) — or pick one from [New issue](https://github.com/FyberLabs/s3r.ch/issues/new/choose).
2. Do not file Hypermesh or Panopticon infrastructure work here.
3. Do not paste SIWE signatures, Gun SEA private keys, session cookies, or personal data. Signed-in is yes/no only.
4. Security reports go to **github@fyberlabs.com** (see [SECURITY.md](SECURITY.md)), not a public issue.

New issues get a `needs-triage` label. That is first-pass intake only.

## If you are an AI

Use the **[AI review](.github/ISSUE_TEMPLATE/ai-review.yml)** form. One cluster of related findings per issue.

- Cite docs paths you actually read: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/identity.md](docs/identity.md), [docs/s3rch-check.md](docs/s3rch-check.md).
- Say whether you ran the app or reviewed docs only. Do not invent stack traces.
- Do not file Hypermesh, Panopticon, AKS, or other-repo infra here.
- Do not dump credentials, SIWE signatures, Gun SEA keys, cookies, or PII.
- Do not treat this lab as a live search product or as the Hypermesh backlog.

## Labels

These already exist on the repo (keep GitHub defaults such as `bug`, `enhancement`, `question`):

| Label | Use |
| --- | --- |
| `needs-triage` | New intake, not yet scheduled |
| `ai-review` | Filed from the AI review form |
| `scheduled` | Accepted and queued |
| `feed` | Lab feed / news / seeder sources |
| `oracle` | Search or oracle API lookup |
| `auth` | SIWE / session / identity |
| `security` | Security-sensitive, still public (not an advisory) |
