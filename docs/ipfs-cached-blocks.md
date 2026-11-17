# Optional cached direct retrieval (#570)

`createCachedMediaBlocks({provider, cache?, current, signal})` connects the existing ciphertext cache to the existing Kubo block client. Pass the result as `blocks` to `createIpfsMediaTransfer`. The adapter is unmounted and has no default cache, provider, UI route, reader registration or activation.

The caller supplies current media-grant authority and cancellation. If retention is explicitly enabled, construct `createLocalCiphertextCache` with the appropriate opaque session/account scope, current retention consent and bounded policy. These are separate obligations: opting out of local retention need not revoke permission to download directly. The adapter cannot authenticate either predicate or manufacture a grant.

A valid unexpired cache hit supplies ciphertext without provider traffic. The adapter verifies length and raw CID again; the media composition still verifies the full manifest digest and AES-GCM binding before plaintext release. Local existence alone grants no access. A miss, expired/corrupt entry, disabled retention or storage failure can use only the supplied direct provider after a fresh authority check. If that provider is unavailable, retrieval fails; there is no cloud/gateway fallback or automatic retry.

Verified provider bytes are offered to the optional cache. Cache-write quota/failure does not invalidate otherwise valid downloaded bytes and does not establish offline availability. Every return is guarded by current authority/cancellation. Two pending upload/download operations bound this adapter's hash/storage work; provider upload/rate/lifetime limits and cache transaction/retention bounds remain in their respective adapters. This is not an account-wide or cross-tab network quota.

Only ciphertext blocks are retained. Keys, bindings and plaintext stay in the existing grant/composition path. Native integration must close and clear old cache partitions when account/retention policy changes; this wrapper does not own cache lifetime. Keeping a local block neither pins the provider nor proves remote durability. Revocation cannot erase copies already held elsewhere.

Fourteen focused unit cases use real crypto and substituted IndexedDB to cover offline reuse/expiry, disabled retention without opening a database, cancellation/revocation, provider tampering, cache-write failure and bounded read admission. PR CI uses actual Chromium IndexedDB with the direct Kubo protocol substitute: warm a two-block encrypted download, take the provider offline, decrypt from cache without network requests, then refuse cached reads after consent withdrawal and expiry. Consent and clock are explicitly synthetic; live provider and native grant/UI acceptance remain open.

## Explicit cache-only reads

Set `readPolicy: "cache-only"` to prohibit provider reads for this adapter. The policy is validated and captured at construction. A complete verified local hit still requires current authority, cancellation checks, expected size and CID; media composition still verifies the complete digest and AES-GCM binding before plaintext. Missing, evicted, expired, corrupt, disabled or inaccessible cache data fails without contacting the provider. No cache also means unavailable; there is no hidden fallback or retry.

The default `"provider-allowed"` preserves existing behavior. This is a read policy, not a global network switch: an explicitly requested `put()` continues through the selected provider with its own consent and budget checks. Cache-only mode does not promise durable offline availability, extend retention, or grant access. Native UI selection remains unmounted and readers remain unregistered.

Unit cases cover absent/evicted/expired data, storage failures, corruption/size mismatch, absent cache and captured policy. Actual Chromium CI decrypts a fully cached two-block recording with the provider unavailable, then expires the local entries and proves cache-only refusal sends no provider request; the separately configured provider-allowed path still makes its expected failing request.

## Optional producer retention

`put()` now snapshots a bounded block, checks its raw CID against the provider acknowledgement, and offers that verified snapshot to the optional local cache. Upload and download calls share two outstanding adapter slots, including hashing and cache writes. Caller and provider input mutations cannot change the retained snapshot. The adapter overwrites its own snapshot after settlement; provider/browser internal copies remain outside that guarantee.

Only a successful matching acknowledgement and a still-current, non-aborted context can reach retention. Cache quota, storage failure or opt-out does not turn a successful provider acknowledgement into an upload failure. Conversely, an acknowledgement alone does not guarantee local storage or durable remote replication. Local cache consent, TTL, partition and byte/entry bounds remain unchanged; no default retention is enabled. An explicitly configured cache-only playback path can reuse these uploaded ciphertext blocks without a provider download. Missing cache data still fails locally.

Unit coverage includes acknowledged retention, failed/false receipts, caller/provider mutation, optional storage failure, withdrawal/abort and the shared operation bound. Actual Chromium CI uploads two blocks through the real multipart Kubo adapter to the protocol substitute, makes that provider unavailable, decrypts from the producer cache without additional requests, and verifies clearing the cache makes cache-only playback unavailable. Native grant/consent UI and live provider acceptance remain outstanding; readers stay unregistered.
