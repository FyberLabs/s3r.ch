# Release diagnostics

Server request failures and browser crashes emit `s3rch.error.v1` JSON at error
level through the existing App Service console-to-Azure Monitor pipeline. This
uses the same Log Analytics workspace as the App Service and Application Insights;
it does not add a third-party crash endpoint or browser analytics collector.
These are console records, not Application Insights custom-event rows.

The fixed record contains event, severity, kind and the server release version,
optional color and upstream version/color. Browser records additionally carry the
version compiled into the browser bundle and the current deployment labels from
`/api/telemetry/context`, fetched lazily on the first error and reused for that
page. Healthy public browsing makes no telemetry API requests. Client labels are untrusted diagnostics, never routing
or authorization inputs. An old cached browser bundle remains distinguishable
from the server currently accepting its report. Configure the upstream labels
when a browser canary uses a canary plane; leave them unset otherwise.

No error message, stack, prompt, URL, query, user ID, wallet, SEA key, cookie,
IP, user agent, name or age is copied into these records. Standard App Service
HTTP/platform logging has its own retention and access configuration; this
change does not redefine those existing logs. Invalid or extra report fields
are rejected. Reports use only the same-origin first-party endpoint, omit
credentials, have a 1 KiB body cap, and are bounded to 20 per browser page and
120 accepted records per category per process per minute. Browser reports cannot
consume the server-error budget. Transport failure never produces
an unhandled rejection or blocks the page. Error records are best effort and
must not be the sole input to an automatic release decision.

In Log Analytics, filter App Service console entries by `s3rch.error.v1`, parse
the JSON message, and filter `release.version` or `release.color`; browser bundle
and upstream fields distinguish mixed deployments. Access and retention stay
with the existing workspace controls. Configure diagnostics before relying on
these records; a merged implementation does not demonstrate ingestion.

This implements the error/crash attribution portion of #338. Shared-session,
dependency-health and document-compatibility contracts remain separate work.
