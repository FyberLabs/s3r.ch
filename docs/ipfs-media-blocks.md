# Client ciphertext blocks (#570)

`lib/ipfs-media-blocks.ts` is an unmounted browser-compatible integrity helper.
It adds no networking, routes, provider credentials, storage, replication, grants
or reader registration. Existing cloud paths and media encryption are unchanged.
This is a partial #570 implementation, not direct-IPFS delivery acceptance.

## Format and limits

Call `sealMedia` first with the existing tenant/object binding. Pass its encrypted
envelope to `describeMediaBlocks`, then slice the same envelope into consecutive
1 MiB blocks (the last may be shorter). Each block has a canonical lowercase
base32 CIDv1 using raw codec `0x55`, SHA-256 `0x12`, and a 32-byte digest. No UnixFS
DAG, CIDv0, arbitrary codec, gateway URL, or path is accepted. Providers must store
these exact raw block bytes; a normal UnixFS file import can produce a different
CID. This deliberately restricted codec follows the [CID specification](https://specs.ipfs.tech/cid/).

The manifest contains only version 1, total ciphertext bytes, whole-envelope
SHA-256, and ordered block CIDs. It inherits the existing 64 MiB encrypted-envelope
cap, with at most 64 blocks and 16 KiB UTF-8 manifest JSON. It is not yet a format
for arbitrary-length recordings. Segmented recordings need a separately bounded,
authenticated parent contract rather than relaxing this cap silently.

## Trust and playback

The manifest must travel inside authenticated private owner/grant material. Parsing
checks shape and bounds, not authorship, current consent, or access. It must not be
published as proof of authorization. No key, wrap, tenant, object identifier,
caption, provider credential, or URL belongs in this manifest. A CID is neither a
grant nor evidence that a provider still holds the block.

`assembleMediaBlocks` accepts the authenticated manifest JSON and ordered downloaded
blocks. It snapshots bytes before asynchronous work, verifies exact lengths and
all block CIDs, checks the whole-envelope digest and envelope header, and returns
ciphertext only after every check passes. Missing/extra/reordered/tampered blocks
fail. It performs no retry or alternate network access. Call existing `openMedia`
with the currently granted key and tenant/object binding before playback; its GCM
authentication remains mandatory. Header recognition alone cannot prove that the
producer encrypted data, and an attacker-controlled manifest can describe an
attacker-controlled envelope.

Producer and consumer must enforce capture consent and current grant/epoch before
calling these helpers. The helper has no keys and cannot make those decisions.
[IPFS metadata can reveal which CIDs nodes provide or retrieve](https://docs.ipfs.tech/concepts/privacy-and-encryption/);
encrypting bytes does not make network metadata private.

## Resource and integration boundaries

Hashing is serial. Each call snapshots at most 64 MiB plus temporary block/hash
buffers; caller-owned originals and subsequent decryption buffers are additional.
This is an in-memory bounded-object helper, not a streaming recording writer.
Callers must bound aggregate concurrency, retained disk, transfer rates and pin
lifetimes; this utility makes no aggregate resource claim.

Still required under #570: explicit capture/replication consent UI, authenticated
manifest/grant composition, direct client provider/peer upload and fetch, no-cloud
network-path assertions, bounded local persistence/replication and cleanup,
availability states, provider loss and interrupted-upload recovery, and real
multi-client scheduled coverage through Infra. No company-cloud fallback, new
provider, pinning node or shared-host run is enabled here.

Focused unit tests use real Web Crypto and existing media encryption: the standard
raw-block CID vector, round-trip, malformed metadata/codec rejection, bounded
manifest count, tampering/reordering/truncation, wrong object binding, and caller
mutation during asynchronous hashing. They do not establish provider availability,
network routing, private-grant admission or live recording acceptance.
