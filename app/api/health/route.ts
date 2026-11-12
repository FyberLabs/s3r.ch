import { gunHealth } from "@/lib/gun-health";
import { identityHealth } from "../../../identity-health.cjs";
import { panopticonHealth } from "@/lib/dependency-health";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Always 200 while the process serves requests. Each dependency reports its
 * own state so a storage or integration outage is visible without taking the
 * feed, the forum or /gun offline.
 */
export async function GET() {
  const identity = identityHealth();
  return Response.json(
    {
      status: "ok",
      dependencies: {
        gun: await gunHealth(process.env.S3RCH_GUN_HEALTH_URL),
        identity: {
          status: identity.status,
          writable: identity.status === "ok" || identity.status === "unchecked",
          reason: identity.reason,
          checkedAt: identity.checkedAt,
          nextRetryAt: identity.nextRetryAt,
        },
        panopticon: panopticonHealth(),
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
