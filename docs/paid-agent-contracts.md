# Paid agent work contracts

Design for #331, shared with the agreement/allocation surface in #311. This
specifies the application record and decisions; it does not implement a payment
endpoint, enable paid execution, or provision an object. The current deployment
has no paid-job admission service. Treasurer/Commission remains unavailable.

## One agreement, one authority boundary

A paid job is a versioned s3r.ch agreement object protected by SociACL. The same
agreement ID, parties, allocation reference and decision history appear in #311;
paid-agent work adds a bounded job specification and execution reference. Do not
create a second contracting ledger or a new identity system.

The record belongs in the s3r.ch Spanopticon tenant's protected store. SociACL
supplies identity, current Check, grants and revocation; the application owns the
commercial terms below. This is an application object using those contracts,
not a claim that SociACL already implements a paid-job primitive. Creating an
agreement requires the owning service's authenticated object admission. A signed
browser document or a storage key does not create that authority.

The immutable terms document contains:

| Field | Required meaning |
| --- | --- |
| `version`, `type` | `1`, `s3rch-paid-job`; unknown versions refuse execution |
| `tenant`, `agreement`, `allocation` | Tenant-bound admitted object IDs, shared with #311 |
| `buyer`, `seller`, `agent` | Stable SEA principals; seller is the responsible service provider, agent is its scoped delegate |
| `job` | Named/versioned job type, input object IDs and digests, exact parameters, output format, size/count/runtime limits |
| `price` | Fixed USD amount in integer cents, disclosed taxes and fees, and the total buyer charge; no floating-point or open-ended usage price |
| `payment` | `stripe-direct`, seller's connected-account binding, test/live mode, and the pre-agreed refund schedule |
| `acceptance` | Named reviewer, objective checks, bounded review rubric, delivery deadline, review duration, and at most one correction round |
| `dispute` | Named neutral mediator, response/decision durations, allowed remedies and the fallback below |
| `access` | Input/output/decision object grants and retention references; forum membership does not imply access |
| `expiresAt`, `nonce` | Offer expiry and unique consent binding |

Canonicalize the exact terms with the existing shared canonical encoding and
bind every consent to the domain, tenant, agreement ID and terms digest. Buyer
and seller consent before execution; the named mediator's willingness and access
scope must also be recorded before activation. Consent cannot be copied to
another tenant, price, input digest, seller account or job. Current identity,
revocation and delegated scope checks remain necessary when admitting each
operation; a previously valid signature alone is insufficient.

Changing terms creates a new proposal with fresh consent. It cannot edit an
active job, enlarge an agent grant, add a fee, or silently replace a mediator.
Signed decisions and provider state are append-only with monotonic revisions and
conditional writes. Conflicting decisions pause execution for reconciliation.
Prompt bodies and private inputs are not copied into operational logs.

## Narrow first job types

Start with a versioned allowlist, not arbitrary instructions or a bidding bus:

- `image.resize.v1`: one granted image, exact target dimensions and fit mode,
  permitted output format, output-byte cap and a delivery deadline. Acceptance
  checks decoding, dimensions, format and the agreed crop/fit rule.
- `document.extract.v1`: one granted document, a specified page range and a
  fixed JSON schema. The signed rubric names required fields, treatment of
  missing values and any buyer-supplied comparison examples. Schema validation
  does not by itself establish factual accuracy; the named reviewer applies the
  agreed rubric.

Each job has one seller and one fixed price. Unsupported types, missing inputs,
ambiguous acceptance, unavailable mediator or missing grants refuse activation.
No recursive subcontracting, unbounded retries, automatic paid follow-on work or
arbitrary external tool access. A correction uses the original scope and price.
AIuditor can impose stricter tool constraints at any time; agreement text,
completion reports and payment status cannot override them.

[NIP-90](https://github.com/nostr-protocol/nips/blob/master/90.md) is marked
unrecommended and points toward use-case-specific standards. We take no payment
or execution authority from its job/result messages. A bot saying “success” is
neither acceptance nor payment confirmation.

## Work and payment are separate state

| Transition | Admission and effect |
| --- | --- |
| Draft → agreed | All required consents bind the same unexpired terms and current principals |
| Agreed → payment pending | One idempotent payment request for the exact agreement, connected account, mode, total and currency |
| Payment pending → ready | Payment owner verifies the provider's successful payment state; browser redirects and forum reports cannot establish it |
| Ready → running | Current grants, allocation, agent scope, AIuditor decision and deadline all permit the exact job |
| Running → delivered | Seller signs output IDs/digests and bounded check results before the delivery deadline |
| Delivered → accepted | Named reviewer signs acceptance of that delivery revision against the original criteria |
| Delivered → correction | Reviewer identifies failed criteria within the review window; the single correction deadline is fixed by the terms |
| Any active state → disputed | An authorized party cites the agreement and disputed delivery/payment revision; further paid work stops |
| Disputed → resolved | Pre-appointed mediator signs one permitted remedy and reasons linked to the original criteria |
| Cancellation/refund required → refund pending | Payment owner requests the applicable provider refund with an idempotency key; no second charge or local balance credit |
| Refund pending → refunded | Provider-confirmed refund, matched to the original account/payment; a timeout remains pending |

A provider success is not irreversible settlement. Track processing, succeeded,
refund pending/refunded and payment-disputed separately from accepted/rejected
work. Reordered or duplicate provider notifications cannot roll state backwards,
start a second job, or repeat a refund. Reconcile uncertain outcomes by querying
the same provider object and account; do not create a replacement payment.

## Disputes are agreed before work

The terms set concrete durations for delivery, buyer review, one correction,
party responses and mediator decision. They also choose these fixed remedies:
accept the submitted result, request the one in-scope correction, full refund,
or a stated partial-refund amount no greater than the paid total. No additional
charge is an available remedy. The mediator receives only the agreement and the
granted inputs/outputs necessary to apply its criteria.

Buyer silence does not invent acceptance: after the signed review duration,
open the pre-agreed dispute path. Late or missing delivery goes to the same path.
If the mediator declines, becomes unavailable, loses its grant, or misses its
signed decision deadline, stop work and require a full refund under the agreed
fallback. A replacement mediator requires a fresh agreement by both parties;
no platform or agent chooses one after the fact. Conflicting authenticated
outcomes remain paused until reconciled through that same path.

Before execution, cancellation refunds the full paid total. Once execution
starts, the signed refund schedule and dispute decision govern; the application
records a refund obligation separately from a provider-confirmed refund. A
seller/provider failure cannot be mislabeled as money returned. A card-network
dispute remains a separate provider process and is not extinguished by a local
mediator decision.

Example: the buyer orders a 512×512 PNG using `contain`, fixed price 500 cents.
The seller supplies 512×384. The buyer cites the dimension criterion during the
review period; the seller gets the one agreed correction window. If it fails,
the named mediator chooses the already-permitted full refund. The payment owner
requests 500 cents back against the original payment and records `refunded` only
on provider confirmation. Neither party can add a new criterion or increase the
price during that dispute.

## Payment boundary and record forms

The seller is the merchant for its service. Stripe Checkout uses a direct charge
on that seller's connected account, scoped by the payment service's verified
account binding. Stripe documents that direct-charge payment objects and balances
belong to the connected account; authoritative reads must use that account.
[Stripe direct charges](https://docs.stripe.com/connect/direct-charges?platform=web&ui=stripe-hosted).

Fyber supplies software and agreement records. This design gives it no pooled
customer balance, escrow wallet, transferable credit, token, deposit/withdrawal
API, or discretionary customer-to-seller payout path. Customer funds do not pass
through an application-controlled custody account. There is no Fyber token and
no on-chain substitute for the payment rail. Fyber's own software charges, if
any, are separately disclosed; this first design adds no application fee to the
seller's job payment.

A direct-charge configuration does not by itself remove platform liability.
Stripe states that negative-balance responsibility and fee configuration affect
which party bears disputes and fees. Record those configured responsibilities;
do not promise that selecting a charge type alone determines regulatory status
or eliminates financial obligations. The design's non-transmission boundary is
the restricted fund flow above, not a legal classification inferred from an API.
[Stripe Connect disputes](https://docs.stripe.com/connect/disputes).

| Agreement form | Stored record | Money movement |
| --- | --- | --- |
| Off-chain, first implementation | Private tenant agreement, consents and decisions under SociACL | Stripe direct charge and provider refund |
| On-chain record, optional later | Explicitly published, non-sensitive commitment to terms/decision digests; no inputs, prompts, personal data or payment credentials | Same provider rail; the chain does not hold or distribute funds |
| Hybrid, optional later | Private agreement remains authoritative; optional public commitments are references | Same provider rail; chain confirmation cannot mark a payment successful |

Publishing a digest is an explicit participant choice: it is permanent and can
link activity. A reorganization or unavailable chain cannot rewrite the private
agreement or block provider reconciliation. No token issuance, crypto escrow,
chain-triggered transfer, or speculative “settled” flag is part of this design.

## Implementation contracts still required

The agreement service must consume authenticated allocation and current SociACL
identity/Check contracts; the payment owner must expose account-bound, idempotent
charge/refund operations and authenticated provider state. The executor must
bind the job digest to its AIuditor-authorized tool plan. These integrations are
not implemented by this document and must not be replaced by browser assertions.

Their CI contracts must cover changed terms after consent, foreign tenants and
seller accounts, rotated/revoked keys, unknown job types, missing grants, excess
cost or runtime, failed/late delivery, conflicting decisions, absent mediator,
duplicate/reordered notifications, uncertain refunds and forged “paid” reports.
The #311 UI reads this same agreement and decision history. It does not enable
Commission until the required runtime contracts exist.
