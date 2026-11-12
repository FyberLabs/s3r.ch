# Tool registry

`/tools` is a read-only inventory of web and local tool harnesses. `ToolListing`
is the common model for Visor session discovery and public MCP Registry catalog
entries. Listing and name verification do not grant execution or claim safety.

## Visor discovery

Import the existing `GET /session/{id}/mcp` JSON response from an authorized
Visor session. The adapter consumes the established profile, server, transport,
routing-status and tool-description fields. It does not scan the machine,
connect to MCP servers, install packages, or start commands. Inverse MCP tools
remain managed by Visor; s3r.ch does not introduce another discovery protocol.

Imports stay in the current browser tab. They are not uploaded, persisted or
shared with another user. Reimport to replace the Visor inventory with a fresh
snapshot. Invalid imports preserve the last displayed list. The parser limits
input to 512 KiB, 128 servers and 2,048 tools, rejects duplicates and excludes
paths, commands, endpoints, environment/header names and trust-review IDs from
the listing model. Tool descriptions are untrusted text, rendered as text.

Visor's `healthy`, `routing_status`, `trust_review`, and provider annotations
are not publisher-name proofs or s3r.ch authorization. Every imported name is
unverified, including names matching official catalog entries. Source-scoped
IDs prevent a catalog record from replacing an imported tool.

Contract checked against hyperme-sh/hypermesh-visor main
`3f71d255437583c50914cce8558d480334b4e785`, `SessionMcpBody` and `ToolInfo`.

## Verified catalog names

The server's bounded lookup calls only the official MCP Registry at
`https://registry.modelcontextprotocol.io/v0.1/servers/{encoded-name}/versions/latest`.
It requires the exact requested name, a version and active registry-managed
status. Publisher-supplied `verifiedPublisher` fields are ignored. Redirects,
compressed/oversized responses, malformed metadata and upstream failures are
rejected. The server caps concurrent lookups at four and requests at eight
seconds. No user credentials or imported Visor data are sent to that registry.

The resulting label means the catalog name was retrieved from the official
registry. It does not verify a connected server, package bytes, installed
version, capabilities, runtime behavior or safety. Catalog records and imported
instances stay separate even when their names match. Remote URLs and package
instructions returned by the registry are never contacted or executed.

Official API contract:
https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/api/openapi.yaml

## Authorization and review

`authorization` and `safetyReview` are always `not-requested` in this inventory.
There is intentionally no execution, installation, or approval action. Tool use
must remain in the owning execution path: resolve the current Visor tool and
arguments, perform the current SociACL grant check and AIuditor decision for
that exact actor/action, and enforce revocation/expiry before dispatch. A catalog
name or imported review ID cannot substitute for those checks.

Scanning produces a separate, artifact-bound result with scanner/version/time;
AIuditor review produces its own scoped decision. Neither is manufactured from a
listing, transport health, publisher name, MCP annotations, or discovery status.
Those execution and review systems retain ownership of their decisions.
