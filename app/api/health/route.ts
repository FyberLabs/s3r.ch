import { forumHealth } from "@/lib/forum-health";
import { gunHealth } from "@/lib/gun-health";
import { identityHealth } from "../../../identity-health.cjs";
import { panopticonHealth } from "@/lib/dependency-health";
import { publicFeedTelemetry } from "@/lib/feed-telemetry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Always 200 while the process serves requests. Each dependency reports its
 * own state so a storage or integration outage is visible without taking the
 * feed, the forum or /gun offline.
 */
export async function GET(request: Request) {
  const identity = identityHealth();
  const peer = process.env.S3RCH_GUN_HEALTH_URL;
  const includeTelemetry = new URL(request.url).searchParams.get("telemetry") === "1";
  return Response.json(
    {
      status: "ok",
      dependencies: {
        forum: forumHealth(),
        gun: await gunHealth(peer),
        identity: {
          status: identity.status,
          writable: identity.status === "ok" || identity.status === "unchecked",
          reason: identity.reason,
          checkedAt: identity.checkedAt,
          nextRetryAt: identity.nextRetryAt,
        },
        panopticon: panopticonHealth(),
      },
      ...(includeTelemetry ? { telemetry: { version: 1, feed: peer ? null : publicFeedTelemetry() } } : {}),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
