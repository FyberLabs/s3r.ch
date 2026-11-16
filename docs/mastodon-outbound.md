# Mastodon publishing for #455

The owned-post control offers **Post to Mastodon**, followed by **Confirm public
Mastodon post**. The existing authenticated outbound route verifies the native
post's current SEA owner and passes that owner to the server adapter. Only the
trimmed body is sent, up to 500 Unicode code points; links and metadata are not
appended. Imports, grants, and mesh sharing never trigger publication.

This is a Mastodon API consumer, not a new ActivityPub server. The configured
provider owns actor identity, ActivityPub signing, object hosting, and federation.
Successful API publication does not prove remote inbox delivery. Arbitrary
ActivityPub providers without the Mastodon API are not supported.

All settings are server-only and absent by default:

| Setting | Meaning |
| --- | --- |
| `MASTODON_OUTBOUND_OWNER` | Exact SEA owner authorized to use this token. |
| `MASTODON_OUTBOUND_ORIGIN` | Trusted operator-configured HTTPS origin, without credentials, path, query, or fragment. |
| `MASTODON_OUTBOUND_ACCOUNT_ID` | Expected numeric provider account ID. |
| `MASTODON_ACCESS_TOKEN` | Secret user token; never `NEXT_PUBLIC_*`, browser storage, or Gun. |

Provisioning this mapping is an operator action; a SEA signature does not prove
ownership of a provider account. No token, account, or service is provisioned by
this source change. Multi-owner credential custody remains separate.

The token needs `read:accounts` (or `profile`) for
[`GET /api/v1/accounts/verify_credentials`](https://docs.joinmastodon.org/methods/accounts/#verify_credentials)
and `write:statuses` for
[`POST /api/v1/statuses`](https://docs.joinmastodon.org/methods/statuses/#create).
The returned account must match the configured ID before any mutation. The
adapter then posts `{status, visibility: "public"}`. The returned status must
identify that same account, public visibility, and a URL on the configured
origin. Installations with a different public URL origin are not supported yet.

Requests refuse redirects, share a ten-second deadline, and limit each decoded
response to 64 KiB. Cancellation aborts fetch and pending body reads. Error text
from the provider is not returned to the browser. No automatic retry is made:
a lost response can follow a successful write, so check the provider account
before retrying. This adapter does not claim exactly-once delivery.

Unit tests substitute provider HTTP responses and cover owner/account mismatch,
configuration replacement before mutation, missing credentials, unsafe URLs,
response bounds, deadlines, cancellation, and body-only publication. These are
not live provider or signed ActivityPub inbox tests. #455 remains open for the
remaining federation/provider acceptance and scheduling under #309. No reader
cases are registered and no shared-host scenario is manually dispatched.
