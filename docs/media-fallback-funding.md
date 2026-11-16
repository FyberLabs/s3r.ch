# Media fallback funding decision

Status: architecture decision for [#571](https://github.com/FyberLabs/s3r.ch/issues/571),
2026-11-16. Product choices listed below remain unresolved. This record enables
no billing, advertising, provider, host routing, seeding, or frontend publication.
It neither changes the existing relay implementation nor supplies missing payment
authority. Runtime defaults and the current frontend queue are unchanged.

## Decision and boundaries

Prefer direct authorized client delivery for live media and client-direct encrypted
IPFS recordings. Direct client traffic is not company usage: it requires neither
company payment nor advertising eligibility. Users may separately buy a provider
with their own credentials; display that provider and payer, without presenting
those transfers as company-funded or free. Company-paid provider or host traffic
is still company fallback even if the packet path bypasses Azure.

Until the remaining product choices, owner contracts, and measured economics are
resolved, do not add a funded-fallback offer. An unavailable direct path must remain
unavailable rather than silently switching to a chargeable relay or gateway.
Existing bounded relay policy remains under its current owner; this document does
not turn an already authorized relay into a paid service or impose a new paywall.

Evaluate three models; none authorizes a charge or an ad integration by itself:

| Model | Eligibility and payer | Advantages | Costs and refusal behavior |
| --- | --- | --- | --- |
| No funded fallback | Direct clients or their independently chosen provider | No company payment/ad dependency | NAT, peer loss, or insufficient client capacity can make media unavailable. Show that state. |
| Explicit prepaid streamer service | A currently authorized streamer opts into a quoted company service using the existing payment owner; confirmed funds and a finite reservation are required | Predictable maximum spend; no ad tracking needed | Payment, metering, refunds and reconciliation must be implemented. No balance or reservation means no new paid admission. |
| Settled sponsorship credits | A sponsor funds a bounded service entitlement through existing accounting; the company bears only an explicitly budgeted risk | Can subsidize fallback without charging the streamer | No fill, blocked ads, rejected impressions, settlement delay and fraud reduce coverage. Pending impressions grant no spendable balance. |

A hybrid may allow payment instead of sponsorship, but it requires an explicit
product choice and a single settlement path per reserved unit. Mandatory ads are
not selected. Ads to streamers, ads to viewers, and sponsorship without impressions
are distinct proposals; none is a default. An unrelated viewer must never acquire
billing liability merely by joining a room.

The approved ceiling remains **32,000,000,000 bytes per tenant per UTC day** for
company-funded streaming/relay/seeding egress, aggregated across services, regions,
providers and processes. Payment, ads, subsidies, host routing, additional wallets
or multiple providers do not multiply that allowance. A company-provisioned paid
relay remains under the ceiling even when a streamer reimburses it. An external
provider independently contracted and paid by the user is separate, not an
automatic escape route when the company budget is exhausted.

## Economics and evidence required before selecting a funded model

There are no measured workload results, vendor quotes, ad yields or settlement
terms in this decision. Do not infer a rate or a viable ad business from the
formulas below. [Infra #1704](https://github.com/FyberLabs/infra/issues/1704) owns
phone/web workloads; [Infra #1705](https://github.com/FyberLabs/infra/issues/1705)
owns dated provider prices and terms. Record currency, taxes, quote date, region,
minimum commitment and rounding units with every candidate rate card.

For an observed interval, measure direct bytes separately. Let `B` be company
egress bytes, including chargeable protocol overhead, retries and redundant
company forwarding, and let `G = 1,000,000,000` (decimal GB). Cost is not always
`B / G * price`: calculate each provider's billed ingress/egress or bidirectional
units, included-transfer tiers, minimums, overages, allocation/IP fees, storage
GB-time, support and operational costs. Avoid charging a provider's included
transfer twice. Allocate fixed commitments transparently in the cost model;
never imply that an unused commitment is a free unlimited allowance.

For a proposed rate card, use:

- `service_cost = sum(provider_billable_units * quoted_unit_cost) + allocated_fixed_costs`.
- `streamer_quote = service_cost_estimate + disclosed_service_fee + applicable_taxes`.
  Whether the fee is zero, fixed or a percentage is unresolved. Never label a
  marked-up price as exact pass-through.
- `settled_sponsor_value = verified_settled_impressions / 1000 * net_settled_eCPM`.
  This is an accounting result, not a client-reported counter. Expected fill,
  estimated eCPM and pending impressions are forecasts only.
- For planning only, `expected_value = opportunities / 1000 * fill_rate *
  verified_fraction * settlement_fraction * net_eCPM`. Compare conservative
  distributions and settlement delays against measured service costs and fraud
  reserves. An expected-value surplus alone cannot authorize live capacity.

A funded interval needs both sufficient *already available* monetary/credit
reservation and sufficient byte allowance. Measure break-even by workload,
region, direct-to-relay ratio and concurrency, not one headline eCPM or price/GB.
If costs accrue before sponsor settlement, either refuse that sponsored admission
or identify a separately capped company subsidy with a named accounting owner.
No implicit overdraft, predicted-credit minting, or automatic card/wallet charge.

As a unit-conversion example only, Core's proposed 3,000,000-bit/s video plus
128,000-bit/s audio is 1,407,600,000 payload bytes per viewer-hour for one egress
copy. Protocol overhead, retries and extra company copies increase this number.
The daily cap therefore allows *less than* 32,000,000,000 / 1,407,600,000 such
viewer-hours once overhead is included; it is not a concurrency or availability
promise. Direct bytes do not enter that calculation. Benchmark actual routes
instead of assuming every viewer uses a relay.

## Admission, reservation and settlement contract

Reuse existing identity, payment, metering and accounting services. s3r.ch is the
consumer UI, not a new wallet, balance ledger, payment authorizer or ad verifier.
A legacy payment receipt or a forum statement alone is not a spend reservation.
The concrete payment/accounting API bindings still need their owners to supply
and review them; endpoint names are deliberately not invented here.

A proposed service quote must bind a current tenant, authorized payer, room and
principal/session, service/provider, route class, policy/rate-card version,
currency, maximum bytes/duration/concurrency, monetary maximum, expiry and stop
behavior. Return only bounded metadata. A quote is not a debit or media grant.
Room access/key grants remain an independent mandatory condition throughout.

Use a stable operation ID through quote acceptance, funds/credits reservation,
byte reservation, admission, usage finalization and reconciliation. Owner-scoped
idempotency must bind the complete request: reusing an ID with changed tenant,
payer, service, limits or price is an error. A status read cannot replay a charge.

The required state progression is:

1. **Quoted:** a finite offer, no service authorization or charge.
2. **Reserving:** the payment owner reserves confirmed funds/settled entitlement;
   the admission owner atomically reserves the shared tenant/day byte allowance.
3. **Admitted:** only after both reservations are confirmed and current room
   authority is valid. A partial reservation never starts traffic. Compensating
   releases are idempotent; a timed-out response is reconciled, not assumed absent.
4. **Active:** enforce reserved bytes, duration and spend. Provider changes require
   a new bounded admission and preserve shared allowance accounting; no automatic
   unlimited fallback. Never expand an existing payer authorization implicitly.
5. **Closing / uncertain:** stop new allocations at the authorized bounds. Retain
   conservative reservations until trusted usage and termination evidence arrive.
   A lost counter, callback, or provider response is not zero usage or a refund.
6. **Finalized:** settle actual authorized usage at the accepted rate, release only
   confirmed unused reservations, and record a bounded reconciliation reference.
   Duplicate completion, retries, restarts and concurrent workers cannot settle
   twice or refund twice. Corrections are attributable compensating entries.

Money reservation and byte reservation may live in different owners. Require
safely retryable reconciliation of their partial outcomes; do not claim a local
UI transaction is atomic across them. Limit live admission to already reserved
service while settlement is unavailable; do not authorize extensions or reuse
uncertain funds. Any provider usage above a user-authorized maximum is a bounded
operator incident under the accepted contract, not a surprise debit to the user.

Account for daily allowance in UTC. An interval crossing midnight needs separate
finite reservation slices for both days or must stop before the unreserved day.
Do not reset an active reservation to zero at rollover. Counter lag and teardown
latency need measured headroom reserved *inside* the ceiling; if the owner cannot
bound the possible egress, refuse admission. Billing units can include costs that
are not egress, but they cannot conceal egress from the aggregate byte ledger.

Revocation follows the appropriate transport owner. Core's proposed <=2-second
controller-loss/relay-revocation bound needs its own CI proof; it is not a browser,
IPFS or offline-peer guarantee. Previously delivered/decrypted bytes cannot be
recalled. A payment or sponsorship entitlement never restores revoked room access.

## Streamer, viewer and operator experience

Before opt-in, show the actual service (TURN, MediaMTX or an explicitly selected
replica), provider/payer, direct versus company route, currency and charging units,
rate and disclosed fee, bounded estimate/range, confirmed available balance or
settled sponsorship entitlement, hard spend/byte/time limits, quote expiry,
refund/reconciliation policy and stop behavior. State uncertainty in an estimate.
Do not hide the service purchase behind a generic join button.

During service, show direct/company traffic separately, measured versus pending
usage, reserved versus settled costs, remaining authorized bounds and a stop
control. Budget exhaustion stops extension and new admission; existing service
stops at its disclosed finite bounds. Give warning when supported, but do not
rely on a foreground browser timer to enforce the cap. If route/counter evidence
is missing, say unknown rather than direct, free, or zero-cost.

Viewers see the connection/availability state and relevant privacy information,
not another user's balance, payer identity or private billing details. Operators
see aggregate allowance, reserved/used/uncertain units, reconciliation failures,
provider health and policy revisions under current operational authorization.
Private support detail requires separate scoped access and retention; ordinary
analytics do not include viewer identities, membership or room content.

No ad SDK, tracking pixel, third-party creative, or impression callback belongs
in a private media surface by default. Before choosing an ad integration, its
owner must specify consent, jurisdiction and age/platform eligibility, retention,
creative isolation, fraud review, settlement/reversal rules and opt-out behavior.
Do not share stream URLs, keys, prompts, private content or membership to qualify
an impression. If age/consent eligibility is unknown, deny ad-funded eligibility
without denying otherwise authorized direct media. No legal-compliance or
age-eligibility determination is asserted by this architecture record.

## Concrete product choices still required

| Choice | Needed decision/evidence | Until resolved |
| --- | --- | --- |
| Funded offer | No company offer, prepaid streamer service, settled sponsorship, or an explicit hybrid; who is the payer? | No new funded offer. |
| Price policy | Dated measured cost basis, currency, fee/markup, tax handling, minimum unit and quote lifetime | No rate card or quote accepted as payable. |
| Funding and risk | Which existing owner reserves funds/credits; whether any company subsidy is allowed, with a finite ceiling and loss owner | No overdraft, pending-ad credit or automatic debit. |
| Advertising | Streamer/viewer/no-impression sponsorship, optional versus mandatory, payment replacement, consent/age/platform/privacy requirements | No ad integration or tracking. |
| Termination and refunds | Finite reservation increments, warning policy, counter-lag headroom, failed-settlement handling, refund/dispute limits | No paid admission. |
| Economics | Measured phone/web route distributions and current provider terms; credible fill/net-yield/settlement/fraud evidence if sponsorship is proposed | No viability claim. |

These are product and service-contract choices, not GitHub reviewer requirements,
new release gates or permission to modify existing approval settings.

## Owner-specific implementation and qualification slices

| Owner / existing issue | Required deliverable |
| --- | --- |
| s3r.ch [#569](https://github.com/FyberLabs/s3r.ch/issues/569), [#570](https://github.com/FyberLabs/s3r.ch/issues/570) | Direct-path controls and truthful route/availability UI, explicit opt-in to any separately authorized company service, bounded client replication. |
| Admission/metering [Core #77](https://github.com/hyperme-sh/controlplane-core/issues/77) and [Infra #1703](https://github.com/FyberLabs/infra/issues/1703) | Atomic cross-provider tenant/day reservations, finite enforcement and reconciliation, current room authority, measured teardown/counter bounds. |
| Benchmark/pricing [Infra #1704](https://github.com/FyberLabs/infra/issues/1704), [#1705](https://github.com/FyberLabs/infra/issues/1705) | Physical-device and browser workload evidence, traffic classification and measured cost model with dated provider terms. |
| Existing payment/billing/accounting owners; concrete binding outstanding | Quote/reserve/settle/release/status contracts, payer consent, immutable rate/amount binding, idempotency, disputes and bounded compensation. No new ledger in s3r.ch. |
| Existing identity/authorization owners | Current payer and room/session attribution plus independent grants; no login/group implementation is transferred by this decision. |
| Product and any later sponsor integration owner | Resolve the table above; a sponsor adapter may consume only owner-verified settlement, never client impression counts as money. |
| Future [Hypermesh #88](https://github.com/hyperme-sh/hypermesh/issues/88) | Paid-host feasibility and verified service accounting, separate from pre-v1 activation; no assumption that hosts are available or anonymous. |

Implementation PRs must cover: concurrent reservations across providers; replayed
acceptance and completion; changed tenant/payer/rate; insufficient funds and byte
allowance independently; partial reservation failure; missing counters; provider
outage; failed/delayed settlement; reversed sponsorship; duplicate refunds;
midnight rollover; restart; estimated versus actual cost; bounds reached during
an active interval; and graceful refusal without automatic charge/fallback.

Unit and isolated contract coverage belongs in PR CI. Real multi-client, provider
and physical-device evidence belongs only in Infra's registered scheduled batch
with declared identities and counter sources. Missing fixtures remain missing;
no synthetic receipt or simulated phone establishes live acceptance. Direct-path
qualification must detect media bytes traversing company API/storage/proxy paths.
No new reader registrations, manual shared-host runs, credentials, provider
subscriptions, real charges or activation are performed by this record.
